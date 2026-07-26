import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./storage/atomic.js";
import type { FavoriteEntry, Source } from "./types.js";

const FAVORITES_PATH = "favorites.json";

function normalizeUsername(username: string, source?: Source): string {
  const normalized = username.trim().replace(/^@/, "").toLowerCase();
  const valid =
    /^[a-z][a-z0-9_]{3,31}$/.test(normalized) &&
    !normalized.includes("__") &&
    !normalized.endsWith("_") &&
    (source !== "telegram" || normalized.length >= 5);
  if (!valid) throw new Error(`Некорректный юзернейм: ${username}`);
  return normalized;
}

function isFavoriteEntry(value: unknown): value is FavoriteEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FavoriteEntry>;
  return (
    typeof entry.username === "string" &&
    (entry.source === "telegram" || entry.source === "fragment") &&
    typeof entry.addedAt === "string" &&
    (entry.note === undefined || typeof entry.note === "string")
  );
}

export function loadFavorites(path = FAVORITES_PATH): FavoriteEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("ожидался массив");
    return parsed.filter(isFavoriteEntry);
  } catch {
    console.warn("[favorites] Не удалось прочитать favorites.json, начинаю с пустого списка.");
    return [];
  }
}

function persist(list: FavoriteEntry[], path: string): void {
  writeJsonAtomic(path, list);
}

export function addFavorite(
  username: string,
  source: Source,
  note?: string,
  path = FAVORITES_PATH,
): FavoriteEntry {
  if (source !== "telegram" && source !== "fragment") {
    throw new Error(`Некорректный источник: ${source}`);
  }
  const normalizedUsername = normalizeUsername(username, source);
  const normalizedNote = note?.trim();
  if (normalizedNote && normalizedNote.length > 240) {
    throw new Error("Комментарий не должен быть длиннее 240 символов");
  }
  const list = loadFavorites(path);
  const existing = list.find(
    (f) => f.username.toLowerCase() === normalizedUsername && f.source === source,
  );
  if (existing) {
    if (normalizedNote) existing.note = normalizedNote;
    persist(list, path);
    return existing;
  }
  const entry: FavoriteEntry = {
    username: normalizedUsername,
    source,
    note: normalizedNote || undefined,
    addedAt: new Date().toISOString(),
  };
  list.push(entry);
  persist(list, path);
  return entry;
}

export function removeFavorite(
  username: string,
  source?: Source,
  path = FAVORITES_PATH,
): number {
  if (source !== undefined && source !== "telegram" && source !== "fragment") {
    throw new Error(`Некорректный источник: ${source}`);
  }
  const normalizedUsername = normalizeUsername(username);
  const list = loadFavorites(path);
  const before = list.length;
  const filtered = list.filter(
    (f) => !(f.username.toLowerCase() === normalizedUsername && (!source || f.source === source)),
  );
  persist(filtered, path);
  return before - filtered.length;
}

export function listFavorites(
  source?: Source,
  path = FAVORITES_PATH,
): FavoriteEntry[] {
  if (source !== undefined && source !== "telegram" && source !== "fragment") {
    throw new Error(`Некорректный источник: ${source}`);
  }
  const list = loadFavorites(path);
  return source ? list.filter((f) => f.source === source) : list;
}
