import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { addFavorite, listFavorites, removeFavorite } from "../favorites.js";
import { loadEnvFile } from "../mtproto/env.js";
import { loadSoldHistory } from "../priceData/store.js";
import { getRates } from "../rates.js";
import { JobManager } from "./jobs.js";
import { saveTelegramCredentials, TelegramLoginFlow } from "./loginFlow.js";
import { normalizeFavoriteInput, validateJobRequest } from "./validation.js";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CURRENT_FILE), "..", "..");
const SOURCE_MODE = CURRENT_FILE.includes(`${sep}src${sep}`);
const WEB_ROOT = resolve(PROJECT_ROOT, "web");
const CLI_ENTRY = resolve(PROJECT_ROOT, SOURCE_MODE ? "src/cli.ts" : "dist/cli.js");
const FAVORITES_PATH = resolve(PROJECT_ROOT, "favorites.json");
const SOLD_HISTORY_PATH = resolve(PROJECT_ROOT, "data", "sold-history.json");
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

interface ServerOptions {
  host?: string;
  port?: number;
}

interface ModelStatus {
  exists: boolean;
  updatedAt?: string;
  trainedAt?: string;
  trainedOn?: number;
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, { error: message });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error("Для изменения данных требуется Content-Type: application/json");
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw new Error("Запрос слишком большой");
    }
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Некорректный JSON");
  }
}

function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "::1", "localhost"].includes(hostname);
  } catch {
    return false;
  }
}

function requestIsAllowed(req: IncomingMessage): boolean {
  if (!isLocalHost(req.headers.host)) return false;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function modelStatus(path: string): ModelStatus {
  if (!existsSync(path)) return { exists: false };
  const status: ModelStatus = {
    exists: true,
    updatedAt: statSync(path).mtime.toISOString(),
  };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (typeof parsed.trainedAt === "string") status.trainedAt = parsed.trainedAt;
    if (typeof parsed.trainedOn === "number") status.trainedOn = parsed.trainedOn;
    if (parsed.metadata && typeof parsed.metadata === "object") {
      const metadata = parsed.metadata as Record<string, unknown>;
      if (typeof metadata.trainedAt === "string") status.trainedAt = metadata.trainedAt;
      if (typeof metadata.trainedOn === "number") status.trainedOn = metadata.trainedOn;
    }
  } catch {
    // Файл существует, но его валидность окончательно проверит команда использования модели.
  }
  return status;
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(WEB_ROOT, requested);
  if (target !== WEB_ROOT && !target.startsWith(`${WEB_ROOT}${sep}`)) {
    sendError(res, 403, "Недопустимый путь");
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendError(res, 404, "Файл не найден");
    return;
  }
  securityHeaders(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.end(readFileSync(target));
}

export function createWebServer(options: ServerOptions = {}): {
  server: Server;
  host: string;
  port: number;
  jobs: JobManager;
  shutdown: () => Promise<void>;
} {
  loadEnvFile(resolve(PROJECT_ROOT, ".env"));
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const jobs = new JobManager({
    projectRoot: PROJECT_ROOT,
    cliEntry: CLI_ENTRY,
    sourceCli: SOURCE_MODE,
  });
  const login = new TelegramLoginFlow(PROJECT_ROOT);
  const sseCleanups = new Set<() => void>();

  const server = createServer(async (req, res) => {
    if (!requestIsAllowed(req)) {
      sendError(res, 403, "Веб-интерфейс доступен только локально");
      return;
    }

    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/api/health" && method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/status" && method === "GET") {
        const favorites = listFavorites(undefined, FAVORITES_PATH);
        const sold = loadSoldHistory(SOLD_HISTORY_PATH);
        sendJson(res, 200, {
          telegram: {
            credentialsConfigured: Boolean(process.env.TG_API_ID && process.env.TG_API_HASH),
            sessionExists: existsSync(resolve(PROJECT_ROOT, ".tg-session")),
            login: login.getStatus(),
          },
          data: {
            soldCount: sold.length,
            favoritesCount: favorites.length,
          },
          models: {
            price: modelStatus(resolve(PROJECT_ROOT, "models", "price-mlp.json")),
            generator: modelStatus(resolve(PROJECT_ROOT, "models", "generator-mlp.json")),
          },
          activeJob: jobs.getActive(),
        });
        return;
      }

      if (pathname === "/api/rates" && method === "GET") {
        // getRates() кэширует на диске и в процессе (15 мин) — тут не нужно
        // своё дополнительное кэширование поверх.
        try {
          sendJson(res, 200, await getRates());
        } catch (err) {
          sendJson(res, 502, {
            error: `Не удалось получить курс TON: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      if (pathname === "/api/favorites" && method === "GET") {
        const source = url.searchParams.get("source");
        if (source && !["telegram", "fragment"].includes(source)) {
          throw new Error("Некорректный фильтр источника");
        }
        sendJson(res, 200, {
          favorites: listFavorites(
            (source ?? undefined) as "telegram" | "fragment" | undefined,
            FAVORITES_PATH,
          ),
        });
        return;
      }

      if (pathname === "/api/favorites" && method === "POST") {
        const entry = normalizeFavoriteInput(await readJson(req));
        sendJson(res, 201, {
          favorite: addFavorite(
            entry.username,
            entry.source,
            entry.note,
            FAVORITES_PATH,
            entry.price,
          ),
        });
        return;
      }

      const favoriteMatch = pathname.match(/^\/api\/favorites\/([^/]+)$/);
      if (favoriteMatch && method === "DELETE") {
        const username = favoriteMatch[1].replace(/^@/, "").toLowerCase();
        const source = url.searchParams.get("source");
        if (source && !["telegram", "fragment"].includes(source)) {
          throw new Error("Некорректный источник");
        }
        const removed = removeFavorite(
          username,
          (source ?? undefined) as "telegram" | "fragment" | undefined,
          FAVORITES_PATH,
        );
        sendJson(res, 200, { removed });
        return;
      }

      if (pathname === "/api/jobs" && method === "GET") {
        sendJson(res, 200, { jobs: jobs.list() });
        return;
      }

      if (pathname === "/api/jobs" && method === "POST") {
        const validated = validateJobRequest(await readJson(req));
        sendJson(res, 202, { job: jobs.create(validated) });
        return;
      }

      const jobEventMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
      if (jobEventMatch && method === "GET") {
        securityHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        const unsubscribe = jobs.subscribe(jobEventMatch[1], (snapshot) => {
          res.write(`event: snapshot\ndata: ${JSON.stringify({ job: snapshot })}\n\n`);
        });
        if (!unsubscribe) {
          res.end(`event: error\ndata: ${JSON.stringify({ error: "Задача не найдена" })}\n\n`);
          return;
        }
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
        heartbeat.unref();
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeat);
          unsubscribe();
          sseCleanups.delete(cleanup);
          if (!res.writableEnded) res.end();
        };
        sseCleanups.add(cleanup);
        req.once("close", cleanup);
        res.once("close", cleanup);
        return;
      }

      const jobCancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (jobCancelMatch && method === "POST") {
        const job = jobs.cancel(jobCancelMatch[1]);
        if (!job) {
          sendError(res, 404, "Задача не найдена");
        } else {
          sendJson(res, 200, { job });
        }
        return;
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && method === "GET") {
        const job = jobs.get(jobMatch[1]);
        if (!job) {
          sendError(res, 404, "Задача не найдена");
        } else {
          sendJson(res, 200, { job });
        }
        return;
      }

      if (pathname === "/api/settings/telegram" && method === "POST") {
        const body = (await readJson(req)) as Record<string, unknown>;
        saveTelegramCredentials(PROJECT_ROOT, body.apiId, body.apiHash);
        sendJson(res, 200, { saved: true });
        return;
      }

      if (pathname === "/api/login" && method === "GET") {
        sendJson(res, 200, { login: login.getStatus() });
        return;
      }

      if (pathname === "/api/login/start" && method === "POST") {
        const body = (await readJson(req)) as Record<string, unknown>;
        sendJson(res, 202, { login: await login.start(body.phone) });
        return;
      }

      if (pathname === "/api/login/answer" && method === "POST") {
        const body = (await readJson(req)) as Record<string, unknown>;
        sendJson(res, 202, { login: login.submitAnswer(body.value) });
        return;
      }

      if (pathname === "/api/login" && method === "DELETE") {
        sendJson(res, 200, { login: await login.cancel() });
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendError(res, 404, "API-метод не найден");
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 405, "Метод не поддерживается");
        return;
      }
      serveStatic(pathname, res);
    } catch (error) {
      sendError(res, 400, error);
    }
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const serverClosed = server.listening
        ? new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          })
        : Promise.resolve();
      for (const cleanup of [...sseCleanups]) cleanup();
      server.closeIdleConnections?.();
      await Promise.allSettled([jobs.dispose(), login.cancel()]);
      await serverClosed;
    })();
    return shutdownPromise;
  };

  server.once("close", () => {
    for (const cleanup of [...sseCleanups]) cleanup();
    if (!shutdownPromise) {
      void jobs.dispose();
      void login.cancel();
    }
  });

  return { server, host, port, jobs, shutdown };
}

export async function startWebServer(options: ServerOptions = {}): Promise<Server> {
  const app = createWebServer(options);
  await new Promise<void>((resolveListen, rejectListen) => {
    app.server.once("error", rejectListen);
    app.server.listen(app.port, app.host, () => {
      app.server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : app.port;
  console.log(`Handle Radar: http://${app.host}:${actualPort}`);

  const handleSignal = () => {
    void app.shutdown().catch((error) => {
      console.error(`Не удалось корректно остановить Handle Radar: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  app.server.once("close", () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  });

  return app.server;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(CURRENT_FILE)) {
  const configuredPort = Number(process.env.WEB_PORT ?? 4173);
  void startWebServer({
    host: "127.0.0.1",
    port: Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 4173,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
