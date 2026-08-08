import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./storage/atomic.js";
import type {
  FavoriteEntry,
  FavoritePrice,
  FavoritePriceLiquidity,
  Source,
} from "./types.js";

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

function isProbability(value: unknown): value is number {
  return isFiniteNonNegative(value) && value <= 1;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isFavoritePriceLiquidity(value: unknown): value is FavoritePriceLiquidity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const liquidity = value as Partial<FavoritePriceLiquidity>;
  return (
    isProbability(liquidity.saleProbability90d) &&
    typeof liquidity.outOfDistribution === "boolean"
  );
}

function isFavoritePrice(value: unknown): value is FavoritePrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const price = value as Partial<FavoritePrice>;
  const hasP10 = price.p10Ton !== undefined;
  const hasP90 = price.p90Ton !== undefined;
  return (
    isFiniteNonNegative(price.ton) &&
    (price.usd === undefined || isFiniteNonNegative(price.usd)) &&
    (price.rub === undefined || isFiniteNonNegative(price.rub)) &&
    hasP10 === hasP90 &&
    (!hasP10 ||
      (isFiniteNonNegative(price.p10Ton) &&
        price.p10Ton <= price.ton &&
        isFiniteNonNegative(price.p90Ton) &&
        price.p90Ton >= price.ton)) &&
    (price.confidence === undefined ||
      price.confidence === "low" ||
      price.confidence === "medium" ||
      price.confidence === "high") &&
    (price.confidenceScore === undefined || isProbability(price.confidenceScore)) &&
    (price.confidenceDefinition === undefined ||
      price.confidenceDefinition === "probability-within-2x" ||
      price.confidenceDefinition === "heuristic-score") &&
    (price.liquidity === undefined || isFavoritePriceLiquidity(price.liquidity)) &&
    (price.releaseGatePassed === undefined ||
      typeof price.releaseGatePassed === "boolean") &&
    (price.priceOutOfDistribution === undefined ||
      typeof price.priceOutOfDistribution === "boolean") &&
    (price.oodScore === undefined || isProbability(price.oodScore)) &&
    (price.modelDisagreementLog === undefined ||
      isFiniteNonNegative(price.modelDisagreementLog)) &&
    (price.comparableEffectiveSampleSize === undefined ||
      isFiniteNonNegative(price.comparableEffectiveSampleSize)) &&
    (price.trainedAt === undefined || isIsoTimestamp(price.trainedAt)) &&
    (price.trainedThrough === undefined || isIsoTimestamp(price.trainedThrough)) &&
    (price.releaseGateReason === undefined ||
      (typeof price.releaseGateReason === "string" &&
        price.releaseGateReason.length > 0 &&
        price.releaseGateReason.length <= 120)) &&
    (price.splitStrategy === undefined ||
      price.splitStrategy === "temporal-group" ||
      price.splitStrategy === "group-random" ||
      price.splitStrategy === "random") &&
    (price.dataCurrent === undefined || typeof price.dataCurrent === "boolean")
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
  if (price.p10Ton !== undefined && price.p90Ton !== undefined) {
    normalized.p10Ton = price.p10Ton;
    normalized.p90Ton = price.p90Ton;
  }
  if (price.confidence !== undefined) normalized.confidence = price.confidence;
  if (price.confidenceScore !== undefined) {
    normalized.confidenceScore = price.confidenceScore;
  }
  if (price.confidenceDefinition !== undefined) {
    normalized.confidenceDefinition = price.confidenceDefinition;
  }
  if (price.liquidity !== undefined) {
    normalized.liquidity = {
      saleProbability90d: price.liquidity.saleProbability90d,
      outOfDistribution: price.liquidity.outOfDistribution,
    };
  }
  if (price.releaseGatePassed !== undefined) {
    normalized.releaseGatePassed = price.releaseGatePassed;
  }
  if (price.priceOutOfDistribution !== undefined) {
    normalized.priceOutOfDistribution = price.priceOutOfDistribution;
  }
  if (price.oodScore !== undefined) normalized.oodScore = price.oodScore;
  if (price.modelDisagreementLog !== undefined) {
    normalized.modelDisagreementLog = price.modelDisagreementLog;
  }
  if (price.comparableEffectiveSampleSize !== undefined) {
    normalized.comparableEffectiveSampleSize = price.comparableEffectiveSampleSize;
  }
  if (price.trainedAt !== undefined) normalized.trainedAt = price.trainedAt;
  if (price.trainedThrough !== undefined) {
    normalized.trainedThrough = price.trainedThrough;
  }
  if (price.releaseGateReason !== undefined) {
    normalized.releaseGateReason = price.releaseGateReason;
  }
  if (price.splitStrategy !== undefined) {
    normalized.splitStrategy = price.splitStrategy;
  }
  if (price.dataCurrent !== undefined) normalized.dataCurrent = price.dataCurrent;
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
