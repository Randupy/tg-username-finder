import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SOURCE_FILES = [
  "src/web/server.ts",
  "src/web/jobs.ts",
  "src/web/loginFlow.ts",
  "src/web/validation.ts",
  "src/favorites.ts",
  "src/types.ts",
  "src/storage/atomic.ts",
  "src/mtproto/env.ts",
  "src/priceData/store.ts",
] as const;

function copyServerSources(isolatedRoot: string): void {
  copyFileSync(
    resolve(PROJECT_ROOT, "package.json"),
    resolve(isolatedRoot, "package.json"),
  );
  for (const relativePath of SERVER_SOURCE_FILES) {
    const target = resolve(isolatedRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(PROJECT_ROOT, relativePath), target);
  }
}

function httpJson(
  port: number,
  path: string,
  options: {
    method?: string;
    hostHeader?: string;
    origin?: string;
    body?: unknown;
  } = {},
): Promise<HttpResponse> {
  const rawBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string | number> = {
    Host: options.hostHeader ?? `127.0.0.1:${port}`,
  };
  if (options.origin) headers.Origin = options.origin;
  if (rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(rawBody);
  }

  return new Promise<HttpResponse>((resolveResponse, rejectResponse) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          let body: unknown = raw;
          try {
            body = raw ? JSON.parse(raw) as unknown : undefined;
          } catch {
            // Keep a non-JSON response as text so failures remain inspectable.
          }
          resolveResponse({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.once("error", rejectResponse);
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

function openSse(
  port: number,
  path: string,
): Promise<{
  req: import("node:http").ClientRequest;
  res: import("node:http").IncomingMessage;
}> {
  return new Promise((resolveStream, rejectStream) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.setEncoding("utf-8");
        res.once("data", () => resolveStream({ req, res }));
      },
    );
    req.once("error", rejectStream);
    req.end();
  });
}

function waitForStreamClose(
  res: import("node:http").IncomingMessage,
  timeoutMs = 2_000,
): Promise<void> {
  if (res.destroyed || res.complete) return Promise.resolve();
  return new Promise<void>((resolveClose, rejectClose) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectClose(new Error(`SSE stream did not close in ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      res.off("end", onClose);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolveClose();
    };
    const onError = (error: Error) => {
      cleanup();
      rejectClose(error);
    };
    res.once("end", onClose);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

test("local server protects mutations and persists favorites inside an isolated root", async () => {
  // server.ts derives PROJECT_ROOT from import.meta.url. Importing a temporary
  // source mirror keeps .env, .tg-session, models, data and .runtime isolated.
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "tg-username-web-server-"));
  const foreignCwd = mkdtempSync(resolve(tmpdir(), "tg-username-web-cwd-"));
  const previousCwd = process.cwd();
  let server: import("node:http").Server | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  try {
    copyServerSources(isolatedRoot);
    symlinkSync(
      resolve(PROJECT_ROOT, "node_modules"),
      resolve(isolatedRoot, "node_modules"),
      "junction",
    );
    mkdirSync(resolve(isolatedRoot, "data"), { recursive: true });
    writeFileSync(
      resolve(isolatedRoot, "data", "sold-history.json"),
      JSON.stringify([
        {
          username: "rootsale",
          priceTon: 100,
          scrapedAt: "2026-07-27T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );
    mkdirSync(resolve(foreignCwd, "data"), { recursive: true });
    writeFileSync(
      resolve(foreignCwd, "favorites.json"),
      JSON.stringify([
        {
          username: "foreignname",
          source: "telegram",
          addedAt: "2026-07-27T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );
    writeFileSync(
      resolve(foreignCwd, "data", "sold-history.json"),
      JSON.stringify([
        {
          username: "foreignsale",
          priceTon: 1,
          scrapedAt: "2026-07-27T00:00:00.000Z",
        },
        {
          username: "foreignsale2",
          priceTon: 2,
          scrapedAt: "2026-07-27T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );
    process.chdir(foreignCwd);

    const serverUrl = pathToFileURL(resolve(isolatedRoot, "src", "web", "server.ts")).href;
    const { createWebServer } = await import(serverUrl) as typeof import("../src/web/server.js");
    const app = createWebServer({ host: "127.0.0.1", port: 0 });
    shutdown = app.shutdown;
    server = app.server;
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once("error", rejectListen);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", rejectListen);
        resolveListen();
      });
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    const localOrigin = `http://127.0.0.1:${port}`;

    const health = await httpJson(port, "/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });
    assert.equal(health.headers["x-frame-options"], "DENY");

    const status = await httpJson(port, "/api/status");
    assert.equal(status.status, 200);
    assert.equal((status.body as any).telegram.sessionExists, false);
    assert.deepEqual((status.body as any).data, {
      soldCount: 1,
      favoritesCount: 0,
    });
    assert.equal((status.body as any).models.price.exists, false);
    assert.equal((status.body as any).models.generator.exists, false);

    const rejectedHost = await httpJson(port, "/api/health", {
      hostHeader: "attacker.example",
    });
    assert.equal(rejectedHost.status, 403);

    const rejectedOrigin = await httpJson(port, "/api/favorites", {
      method: "POST",
      origin: "https://attacker.example",
      body: { username: "shouldnotexist", source: "telegram" },
    });
    assert.equal(rejectedOrigin.status, 403);
    assert.equal(existsSync(resolve(isolatedRoot, "favorites.json")), false);

    const created = await httpJson(port, "/api/favorites", {
      method: "POST",
      origin: localOrigin,
      body: {
        username: "@Alpha_1",
        source: "telegram",
        note: "first pick",
      },
    });
    assert.equal(created.status, 201);
    assert.equal((created.body as any).favorite.username, "alpha_1");
    assert.equal(existsSync(resolve(isolatedRoot, "favorites.json")), true);
    assert.equal(
      JSON.parse(readFileSync(resolve(foreignCwd, "favorites.json"), "utf-8"))[0]
        .username,
      "foreignname",
    );

    const statusWithFavorite = await httpJson(port, "/api/status");
    assert.deepEqual((statusWithFavorite.body as any).data, {
      soldCount: 1,
      favoritesCount: 1,
    });

    const listed = await httpJson(port, "/api/favorites?source=telegram");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (listed.body as any).favorites.map(
        ({ username, source, note }: Record<string, unknown>) => ({
          username,
          source,
          note,
        }),
      ),
      [{ username: "alpha_1", source: "telegram", note: "first pick" }],
    );
    assert.ok(
      JSON.parse(readFileSync(resolve(isolatedRoot, "favorites.json"), "utf-8"))
        .some((favorite: { username?: string }) => favorite.username === "alpha_1"),
    );

    const removed = await httpJson(
      port,
      "/api/favorites/alpha_1?source=telegram",
      {
        method: "DELETE",
        origin: localOrigin,
      },
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { removed: 1 });

    const finalList = await httpJson(port, "/api/favorites");
    assert.equal(finalList.status, 200, JSON.stringify(finalList.body));
    assert.deepEqual(finalList.body, { favorites: [] });

    const sseJob = app.jobs.create({
      type: "collect-sales",
      args: ["collect-sales", "--pages", "1", "--delay", "250"],
      expectsResult: false,
      totalUnits: 1,
    });
    const stream = await openSse(
      port,
      `/api/jobs/${encodeURIComponent(sseJob.id)}/events`,
    );
    const streamClosed = waitForStreamClose(stream.res);
    await app.shutdown();
    await streamClosed;
    assert.equal(server.listening, false);
    stream.req.destroy();
  } finally {
    if (shutdown) {
      await shutdown();
    } else if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server!.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
    process.chdir(previousCwd);
    const isolatedModules = resolve(isolatedRoot, "node_modules");
    try {
      if (existsSync(isolatedModules)) unlinkSync(isolatedModules);
    } catch {
      // Windows may briefly retain the junction while the TS loader shuts down.
    }
    try {
      rmSync(isolatedRoot, { recursive: true, force: true });
    } catch {
      // Best effort: this is an OS-temp mirror containing no user data.
    }
    try {
      rmSync(foreignCwd, { recursive: true, force: true });
    } catch {
      // On Windows the test runner can briefly retain the former cwd handle.
    }
  }
});
