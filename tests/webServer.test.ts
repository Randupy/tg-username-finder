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
  "src/favoritesExport.ts",
  "src/xlsxWriter.ts",
  "src/types.ts",
  "src/storage/atomic.ts",
  "src/mtproto/env.ts",
  "src/priceData/store.ts",
  "src/rates.ts",
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

interface HttpBinaryResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Like httpJson, but keeps the response as raw bytes — httpJson's setEncoding("utf-8")
 *  would corrupt a binary payload like a .xlsx file. */
function httpBinary(
  port: number,
  path: string,
  options: { hostHeader?: string } = {},
): Promise<HttpBinaryResponse> {
  return new Promise<HttpBinaryResponse>((resolveResponse, rejectResponse) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Host: options.hostHeader ?? `127.0.0.1:${port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolveResponse({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.once("error", rejectResponse);
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
    mkdirSync(resolve(isolatedRoot, "web", "assets"), { recursive: true });
    copyFileSync(
      resolve(PROJECT_ROOT, "web", "assets", "token-mark.svg"),
      resolve(isolatedRoot, "web", "assets", "token-mark.svg"),
    );
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

    const logo = await httpJson(port, "/assets/token-mark.svg");
    assert.equal(logo.status, 200);
    assert.equal(logo.headers["content-type"], "image/svg+xml");
    assert.match(String(logo.body), /<svg\b/);

    const status = await httpJson(port, "/api/status");
    assert.equal(status.status, 200);
    assert.equal((status.body as any).telegram.sessionExists, false);
    assert.deepEqual((status.body as any).data, {
      soldCount: 1,
      favoritesCount: 0,
    });
    assert.equal((status.body as any).models.price.exists, false);
    assert.equal((status.body as any).models.price.valid, false);
    assert.equal((status.body as any).models.generator.exists, false);

    mkdirSync(resolve(isolatedRoot, "models"), { recursive: true });
    const corruptPriceModelPath = resolve(
      isolatedRoot,
      "models",
      "price-mlp.json",
    );
    writeFileSync(corruptPriceModelPath, "{not-json", "utf8");
    const corruptModelStatus = await httpJson(port, "/api/status");
    assert.equal((corruptModelStatus.body as any).models.price.exists, true);
    assert.equal((corruptModelStatus.body as any).models.price.valid, false);
    assert.equal(
      typeof (corruptModelStatus.body as any).models.price.reason,
      "string",
    );
    unlinkSync(corruptPriceModelPath);

    // Курсы TON зависят от внешнего запроса к CoinGecko, недоступного в
    // изолированной тестовой среде — проверяем только то, что маршрут
    // подключён и отвечает предсказуемой формой (успех или явная 502), а не
    // конкретные значения курса.
    const rates = await httpJson(port, "/api/rates");
    if (rates.status === 200) {
      assert.equal(typeof (rates.body as any).tonUsd, "number");
      assert.equal(typeof (rates.body as any).usdRub, "number");
    } else {
      assert.equal(rates.status, 502);
      assert.equal(typeof (rates.body as any).error, "string");
    }

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

    const richFavoritePrice = {
      ton: 125.5,
      usd: 380,
      rub: 29_000,
      p10Ton: 80,
      p90Ton: 240,
      confidence: "high",
      confidenceScore: 0.82,
      confidenceDefinition: "probability-within-2x",
      liquidity: {
        saleProbability90d: 0.64,
        outOfDistribution: false,
      },
      releaseGatePassed: false,
      priceOutOfDistribution: true,
      oodScore: 0.76,
      modelDisagreementLog: 0.31,
      comparableEffectiveSampleSize: 2.5,
      trainedAt: "2026-07-30T12:00:00.000Z",
      trainedThrough: "2026-07-29T12:00:00.000Z",
      releaseGateReason: "non-temporal-evaluation",
      splitStrategy: "group-random",
      dataCurrent: true,
    };
    const created = await httpJson(port, "/api/favorites", {
      method: "POST",
      origin: localOrigin,
      body: {
        username: "@Alpha_1",
        source: "telegram",
        note: "first pick",
        price: richFavoritePrice,
      },
    });
    assert.equal(created.status, 201);
    assert.equal((created.body as any).favorite.username, "alpha_1");
    assert.deepEqual((created.body as any).favorite.price, richFavoritePrice);
    assert.equal(existsSync(resolve(isolatedRoot, "favorites.json")), true);
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(isolatedRoot, "favorites.json"), "utf-8"))[0]
        .price,
      richFavoritePrice,
    );
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
        ({ username, source, note, price }: Record<string, unknown>) => ({
          username,
          source,
          note,
          price,
        }),
      ),
      [
        {
          username: "alpha_1",
          source: "telegram",
          note: "first pick",
          price: richFavoritePrice,
        },
      ],
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

test("GET /api/favorites/export.xlsx returns the full favorites list as a workbook", async () => {
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "tg-username-web-export-"));
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
      JSON.stringify([]),
      "utf-8",
    );
    // Записан напрямую, а не через POST /api/favorites — этот тест проверяет
    // экспорт целиком независимо от CRUD-путей, которые уже покрыты выше.
    writeFileSync(
      resolve(isolatedRoot, "favorites.json"),
      JSON.stringify([
        {
          username: "coolvibe",
          source: "telegram",
          note: "звучное, короткое",
          price: { ton: 125.5, usd: 380, rub: 29_000 },
          addedAt: "2026-07-27T00:00:00.000Z",
        },
        {
          username: "topauto",
          source: "fragment",
          addedAt: "2026-07-26T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );
    process.chdir(isolatedRoot);

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

    const rejectedHost = await httpBinary(port, "/api/favorites/export.xlsx", {
      hostHeader: "attacker.example",
    });
    assert.equal(rejectedHost.status, 403);

    const exported = await httpBinary(port, "/api/favorites/export.xlsx");
    assert.equal(exported.status, 200);
    assert.equal(
      exported.headers["content-type"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    assert.match(
      String(exported.headers["content-disposition"]),
      /attachment; filename="favorites\.xlsx"/,
    );
    // ZIP-сигнатура "PK\x03\x04" — подтверждает, что это действительно
    // валидный архив, а не JSON-ошибка или пустое тело.
    assert.deepEqual(exported.body.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // Записи упакованы без сжатия (STORED), поэтому XML-текст листа виден
    // прямо в теле ответа — не нужен ZIP-ридер, чтобы проверить содержимое.
    const containsUtf8 = (text: string) => exported.body.includes(Buffer.from(text, "utf-8"));
    assert.ok(containsUtf8("coolvibe"), "должен содержать первый юзернейм");
    assert.ok(containsUtf8("topauto"), "должен содержать второй юзернейм");
    assert.ok(containsUtf8("звучное, короткое"), "должен содержать заметку с юникодом");
    assert.ok(containsUtf8("Юзернейм"), "должен содержать заголовок колонки");
  } finally {
    if (shutdown) {
      await shutdown();
    } else if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server!.close((error) => (error ? rejectClose(error) : resolveClose()));
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
  }
});
