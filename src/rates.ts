import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./storage/atomic.js";

const CACHE_PATH = "data/rates-cache.json";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 минут — курсы не нужно дёргать чаще
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 15 * 60 * 1000;
const TON_RATES_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd,rub";
let inProcessRates: Rates | null = null;
let refreshInFlight: Promise<Rates> | null = null;
let refreshRetryAfter = 0;
let consecutiveRefreshFailures = 0;
let lastRefreshError: Error | null = null;

export interface Rates {
  tonUsd: number;
  usdRub: number;
  fetchedAt: string;
}

/**
 * CoinGecko Simple Price возвращает TON сразу в USD и RUB одним публичным
 * запросом без ключа. Косвенный USD/RUB нужен только для совместимости
 * convertTon и вычисляется как TON/RUB ÷ TON/USD.
 *
 * Сервис может временно быть недоступен или поменять формат ответа, поэтому
 * результат кэшируется на диске, а при сбое сети используется последний
 * корректный кэш (с явным предупреждением).
 */
export async function fetchFreshRates(fetchImpl: typeof fetch = globalThis.fetch): Promise<Rates> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(TON_RATES_URL, { signal });

  if (!response.ok) throw new Error(`CoinGecko вернул статус ${response.status}`);

  const json = (await response.json()) as {
    "the-open-network"?: { usd?: number; rub?: number };
  };

  const tonUsd = json["the-open-network"]?.usd;
  const tonRub = json["the-open-network"]?.rub;
  if (
    !Number.isFinite(tonUsd) ||
    !Number.isFinite(tonRub) ||
    (tonUsd ?? 0) <= 0 ||
    (tonRub ?? 0) <= 0
  ) {
    throw new Error(
      "Не удалось разобрать USD/RUB-котировки TON из ответа CoinGecko — формат мог измениться.",
    );
  }

  return {
    tonUsd: tonUsd!,
    usdRub: tonRub! / tonUsd!,
    fetchedAt: new Date().toISOString(),
  };
}

function isRates(value: unknown): value is Rates {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Rates>;
  return (
    typeof candidate.tonUsd === "number" &&
    Number.isFinite(candidate.tonUsd) &&
    candidate.tonUsd > 0 &&
    typeof candidate.usdRub === "number" &&
    Number.isFinite(candidate.usdRub) &&
    candidate.usdRub > 0 &&
    typeof candidate.fetchedAt === "string" &&
    Number.isFinite(new Date(candidate.fetchedAt).getTime())
  );
}

function readCachedRates(): Rates | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (isRates(parsed)) return parsed;
    console.error(`⚠️  Кэш курсов ${CACHE_PATH} имеет неверный формат, запрашиваю свежие данные.`);
  } catch (err) {
    console.error(
      `⚠️  Не удалось прочитать кэш курсов ${CACHE_PATH} ` +
        `(${err instanceof Error ? err.message : err}), запрашиваю свежие данные.`,
    );
  }
  return null;
}

function clearRefreshFailure(): void {
  refreshRetryAfter = 0;
  consecutiveRefreshFailures = 0;
  lastRefreshError = null;
}

function rememberRefreshFailure(error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  consecutiveRefreshFailures++;
  const delay = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.min(10, consecutiveRefreshFailures - 1),
  );
  refreshRetryAfter = Date.now() + delay;
  lastRefreshError = normalized;
  return normalized;
}

export async function getRates(
  force = false,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Rates> {
  const now = Date.now();
  if (!force && inProcessRates) {
    const inProcessAge = now - new Date(inProcessRates.fetchedAt).getTime();
    if (inProcessAge >= 0 && inProcessAge < CACHE_TTL_MS) return inProcessRates;
    // Keep a stale value as a fast fallback while an upstream failure is in
    // negative cache. This is what prevents one timeout per username.
    if (now < refreshRetryAfter) return inProcessRates;
  }

  const cached = readCachedRates();
  if (!force && cached) {
    const age = now - new Date(cached.fetchedAt).getTime();
    if (age >= 0 && age < CACHE_TTL_MS) {
      inProcessRates = cached;
      clearRefreshFailure();
      return cached;
    }
  }
  const staleFallback = cached ?? inProcessRates;

  if (!force && now < refreshRetryAfter) {
    if (staleFallback) {
      inProcessRates = staleFallback;
      return staleFallback;
    }
    throw lastRefreshError ?? new Error("Rate refresh is temporarily in retry backoff.");
  }

  // Concurrent price estimates share one upstream request as well as the
  // subsequent negative-cache decision.
  if (refreshInFlight) return refreshInFlight;

  const refresh = (async (): Promise<Rates> => {
    try {
      const fresh = await fetchFreshRates(fetchImpl);
      writeJsonAtomic(CACHE_PATH, fresh);
      inProcessRates = fresh;
      clearRefreshFailure();
      return fresh;
    } catch (error) {
      const normalized = rememberRefreshFailure(error);
      if (staleFallback) {
        console.error(
          `⚠️  Не удалось обновить курсы (${normalized.message}), использую устаревший кэш до следующей попытки.`,
        );
        inProcessRates = staleFallback;
        return staleFallback;
      }
      throw normalized;
    } finally {
      refreshInFlight = null;
    }
  })();
  refreshInFlight = refresh;
  return refresh;
}

export function convertTon(ton: number, rates: Rates): { ton: number; usd: number; rub: number } {
  const usd = ton * rates.tonUsd;
  const rub = usd * rates.usdRub;
  return { ton, usd, rub };
}
