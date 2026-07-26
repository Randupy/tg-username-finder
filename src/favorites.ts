import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./storage/atomic.js";
import type { FavoriteEntry, FavoritePrice, Source } from "./types.js";

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
    (entry.note === undefined || typeof entry.note === "string") &&
    (entry.price === undefined || isFavoritePrice(entry.price))
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFavoritePrice(value: unknown): value is FavoritePrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const price = value as Partial<FavoritePrice>;
  return (
    isFiniteNonNegative(price.ton) &&
    (price.usd === undefined || isFiniteNonNegative(price.usd)) &&
    (price.rub === undefined || isFiniteNonNegative(price.rub))
  );
}

function normalizePrice(price?: FavoritePrice): FavoritePrice | undefined {
  if (price === undefined) return undefined;
  if (!isFavoritePrice(price)) {
    throw new Error("Цена должна содержать неотрицательное конечное значение ton");
  }
  const normalized: FavoritePrice = { ton: price.ton };
  if (price.usd !== undefined) normalized.usd = price.usd;
  if (price.rub !== undefined) normalized.rub = price.rub;
  return normalized;
}

function addedAtTimestamp(entry: FavoriteEntry): number {
  const timestamp = Date.parse(entry.addedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
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
  price?: FavoritePrice,
): FavoriteEntry {
  if (source !== "telegram" && source !== "fragment") {
    throw new Error(`Некорректный источник: ${source}`);
  }
  const normalizedUsername = normalizeUsername(username, source);
  const normalizedNote = note?.trim();
  if (normalizedNote && normalizedNote.length > 240) {
    throw new Error("Комментарий не должен быть длиннее 240 символов");
  }
  const normalizedPrice = normalizePrice(price);
  const list = loadFavorites(path);
  const existing = list.find(
    (f) => f.username.toLowerCase() === normalizedUsername && f.source === source,
  );
  if (existing) {
    if (normalizedNote) existing.note = normalizedNote;
    if (normalizedPrice) existing.price = normalizedPrice;
    persist(list, path);
    return existing;
  }
  const entry: FavoriteEntry = {
    username: normalizedUsername,
    source,
    note: normalizedNote || undefined,
    price: normalizedPrice,
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
  const filtered = source ? list.filter((f) => f.source === source) : list;
  return [...filtered].sort((a, b) => addedAtTimestamp(b) - addedAtTimestamp(a));
}
