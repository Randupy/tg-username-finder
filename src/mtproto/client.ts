import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { writeTextAtomic } from "../storage/atomic.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

export const SESSION_PATH = resolve(process.cwd(), ".tg-session");

export function readSavedSession(): string {
  if (!existsSync(SESSION_PATH)) return "";
  return readFileSync(SESSION_PATH, "utf-8").trim();
}

export function saveSession(sessionString: string): void {
  writeTextAtomic(SESSION_PATH, `${sessionString.trim()}\n`, 0o600);
}

function readCredentials(): { apiId: number; apiHash: string } {
  const apiIdRaw = process.env.TG_API_ID;
  const apiHash = process.env.TG_API_HASH;
  if (!apiIdRaw || !apiHash) {
    throw new Error(
      "Не заданы TG_API_ID / TG_API_HASH. Получите их на https://my.telegram.org → " +
        "'API development tools' и положите в .env (см. .env.example), " +
        "затем выполните: npm run login",
    );
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId)) {
    throw new Error(`TG_API_ID должен быть числом, получено: "${apiIdRaw}"`);
  }
  return { apiId, apiHash };
}

let clientPromise: Promise<TelegramClient> | null = null;

/**
 * Connects and verifies a constructed client. Any failure after construction
 * closes the partially initialized client while preserving the original error.
 */
export async function connectAndAuthorizeClient(client: TelegramClient): Promise<TelegramClient> {
  try {
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      throw new Error(
        "Сохранённая сессия недействительна (разлогинились/отозван доступ). " +
          "Выполните заново: npm run login",
      );
    }
    return client;
  } catch (error) {
    try {
      await client.disconnect();
    } catch {
      // Cleanup must not hide the connection/authorization failure.
    }
    throw error;
  }
}

async function initializeClient(): Promise<TelegramClient> {
  const { apiId, apiHash } = readCredentials();
  const sessionString = readSavedSession();

  if (!sessionString) {
    throw new Error(
      "Не найдена сохранённая сессия Telegram (.tg-session). " +
        "Сначала выполните разовый вход: npm run login",
    );
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  return connectAndAuthorizeClient(client);
}

/**
 * Возвращает подключённый, авторизованный TelegramClient (singleton на
 * процесс). Требует, чтобы `npm run login` был выполнен ранее и сохранил
 * сессию в .tg-session — сам эту функцию логин не делает (см. mtproto/login.ts).
 */
export async function getClient(): Promise<TelegramClient> {
  if (clientPromise) return clientPromise;

  const pending = initializeClient();
  clientPromise = pending;
  try {
    return await pending;
  } catch (error) {
    // A transient failure must not poison the process-wide singleton forever.
    if (clientPromise === pending) clientPromise = null;
    throw error;
  }
}

export async function disconnectClient(): Promise<void> {
  const pending = clientPromise;
  if (!pending) return;

  try {
    let client: TelegramClient;
    try {
      client = await pending;
    } catch {
      // initializeClient already cleaned up a partially initialized client.
      return;
    }
    await client.disconnect();
  } finally {
    if (clientPromise === pending) clientPromise = null;
  }
}
