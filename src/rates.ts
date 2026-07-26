import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./storage/atomic.js";

const CACHE_PATH = "data/rates-cache.json";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 минут — курсы не нужно дёргать чаще
const REQUEST_TIMEOUT_MS = 10_000;
const TON_RATES_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd,rub";
let inProcessRates: Rates | null = null;

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

export async function getRates(force = false): Promise<Rates> {
  if (!force && inProcessRates) return inProcessRates;

  const cached = readCachedRates();
  if (!force && cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age >= 0 && age < CACHE_TTL_MS) {
      inProcessRates = cached;
      return cached;
    }
  }

  try {
    const fresh = await fetchFreshRates();
    writeJsonAtomic(CACHE_PATH, fresh);
    inProcessRates = fresh;
    return fresh;
  } catch (err) {
    if (cached) {
      console.error(
        `⚠️  Не удалось обновить курсы (${err instanceof Error ? err.message : err}), использую кэш с диска.`,
      );
      // Один CLI/job-процесс не должен повторять заведомо неудачный сетевой
      // запрос для каждого следующего username в той же пачке.
      inProcessRates = cached;
      return cached;
    }
    throw err;
  }
}

export function convertTon(ton: number, rates: Rates): { ton: number; usd: number; rub: number } {
  const usd = ton * rates.tonUsd;
  const rub = usd * rates.usdRub;
  return { ton, usd, rub };
}
