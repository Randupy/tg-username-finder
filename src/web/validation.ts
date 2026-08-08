import type {
  DigitsPolicy,
  FavoritePrice,
  GenMode,
  SourceOption,
  WordPosition,
} from "../types.js";

export type JobType =
  | "search"
  | "collect-sales"
  | "train-price"
  | "train-generator"
  | "generate-ai";

export interface ValidatedJob {
  type: JobType;
  args: string[];
  expectsResult: boolean;
  totalUnits?: number;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, label = "payload"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} должен быть JSON-объектом`);
  }
  return value as JsonObject;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
  integer = true,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : fallback;

  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label}: требуется ${integer ? "целое " : ""}число`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${label}: допустимый диапазон ${min}–${max}`);
  }
  return parsed;
}

/** Как asNumber, но возвращает undefined, если поле не заполнено — для необязательных фильтров. */
function asOptionalNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = true,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return asNumber(value, 0, label, min, max, integer);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  const normalized = asString(value, fallback);
  if (!allowed.includes(normalized as T)) {
    throw new Error(`${label}: допустимо ${allowed.join(", ")}`);
  }
  return normalized as T;
}

function pushFlag(args: string[], enabled: boolean, flag: string): void {
  if (enabled) args.push(flag);
}

function validateSearch(params: JsonObject): ValidatedJob {
  const source = oneOf<SourceOption>(
    params.source,
    ["telegram", "fragment", "both"],
    "both",
    "Источник",
  );
  const mode = oneOf<Exclude<GenMode, "ai">>(
    params.mode,
    ["readable", "random", "word", "translit", "dictionary", "compound", "both"],
    "both",
    "Режим",
  );
  const digits = oneOf<DigitsPolicy>(
    params.digits,
    ["exclude", "allow", "require"],
    "exclude",
    "Цифры",
  );
  if (mode === "translit" && digits === "require") {
    throw new Error(
      "Транслит-режим не добавляет цифры: выберите «Исключить» или «Разрешить»",
    );
  }
  const minimumAllowedLength = source === "fragment" ? 4 : 5;
  const minLength = asNumber(
    params.minLength,
    5,
    "Минимальная длина",
    minimumAllowedLength,
    32,
  );
  const maxLength = asNumber(
    params.maxLength,
    8,
    "Максимальная длина",
    minimumAllowedLength,
    32,
  );
  const count = asNumber(params.count, 20, "Количество", 1, 200);
  const delay = asNumber(params.delayMs, 2000, "Задержка", 250, 60_000);
  const wordPosition = oneOf<WordPosition>(
    params.wordPosition,
    ["start", "middle", "end", "any"],
    "any",
    "Позиция слова",
  );
  const minPriceTon = asOptionalNumber(
    params.minPriceTon,
    "Минимальная цена, TON",
    0,
    1_000_000_000,
    false,
  );

  if (minLength > maxLength) {
    throw new Error("Минимальная длина не может быть больше максимальной");
  }

  const args = [
    "search",
    "--source",
    source,
    "--mode",
    mode,
    "--min-length",
    String(minLength),
    "--max-length",
    String(maxLength),
    "--digits",
    digits,
    "--count",
    String(count),
    "--delay",
    String(delay),
  ];

  if (minPriceTon !== undefined) {
    args.push("--min-price-ton", String(minPriceTon));
  }

  const charset = asString(params.charset);
  if (charset) {
    if (!/^[a-zA-Z]+$/.test(charset)) {
      throw new Error("Набор символов может содержать только латинские буквы");
    }
    args.push("--charset", [...new Set(charset.toLowerCase())].join(""));
  }

  if (mode === "word") {
    const word = asString(params.word).toLowerCase();
    if (!/^[a-z][a-z0-9]*$/.test(word)) {
      throw new Error("Слово должно начинаться с буквы и содержать только a–z и цифры");
    }
    if (word.length > maxLength) {
      throw new Error("Слово длиннее максимальной длины юзернейма");
    }
    args.push("--word", word, "--word-position", wordPosition);
  }

  pushFlag(args, asBoolean(params.debug), "--debug");
  pushFlag(args, asBoolean(params.usePlaywright), "--playwright");
  pushFlag(args, asBoolean(params.legacyWeb), "--legacy-web");
  pushFlag(args, asBoolean(params.estimatePrice), "--estimate-price");
  pushFlag(args, asBoolean(params.dryRun), "--dry-run");
  pushFlag(args, asBoolean(params.safeMode), "--safe-mode");

  return { type: "search", args, expectsResult: true, totalUnits: count };
}

function validateCollect(params: JsonObject): ValidatedJob {
  const pages = asNumber(params.pages, 3, "Количество страниц", 1, 50);
  const delay = asNumber(params.delayMs, 2000, "Задержка", 250, 60_000);
  const args = [
    "collect-sales",
    "--pages",
    String(pages),
    "--delay",
    String(delay),
  ];
  pushFlag(args, asBoolean(params.debug), "--debug");
  return { type: "collect-sales", args, expectsResult: false, totalUnits: pages };
}

function validateTraining(
  type: "train-price" | "train-generator",
  params: JsonObject,
): ValidatedJob {
  const fallback = 100;
  const epochs = asNumber(params.epochs, fallback, "Количество эпох", 1, 5000);
  const args = [type, "--epochs", String(epochs)];
  if (type === "train-generator") {
    const dictionaryWords = asNumber(
      params.dictionaryWords,
      1200,
      "Слов словаря",
      0,
      8742,
    );
    args.push("--dictionary-words", String(dictionaryWords));
  }
  return {
    type,
    args,
    expectsResult: false,
    totalUnits: epochs,
  };
}

function validateGenerateAi(params: JsonObject): ValidatedJob {
  const count = asNumber(params.count, 20, "Количество", 1, 200);
  const minLength = asNumber(params.minLength, 5, "Минимальная длина", 5, 32);
  const maxLength = asNumber(params.maxLength, 8, "Максимальная длина", 5, 32);
  const temperature = asNumber(params.temperature, 0.8, "Температура", 0, 3, false);
  const delay = asNumber(params.delayMs, 2000, "Задержка", 250, 60_000);
  const minPriceTon = asOptionalNumber(
    params.minPriceTon,
    "Минимальная цена, TON",
    0,
    1_000_000_000,
    false,
  );
  if (minLength > maxLength) {
    throw new Error("Минимальная длина не может быть больше максимальной");
  }

  const args = [
    "generate-ai",
    "--count",
    String(count),
    "--min-length",
    String(minLength),
    "--max-length",
    String(maxLength),
    "--temperature",
    String(temperature),
    "--delay",
    String(delay),
  ];

  if (minPriceTon !== undefined) {
    args.push("--min-price-ton", String(minPriceTon));
  }

  const sourceRaw = asString(params.source);
  if (sourceRaw) {
    const source = oneOf<SourceOption>(
      sourceRaw,
      ["telegram", "fragment", "both"],
      "both",
      "Источник",
    );
    args.push("--source", source);
  }
  pushFlag(args, asBoolean(params.estimatePrice), "--estimate-price");
  pushFlag(args, asBoolean(params.safeMode), "--safe-mode");

  return { type: "generate-ai", args, expectsResult: true, totalUnits: count };
}

export function validateJobRequest(input: unknown): ValidatedJob {
  const body = asObject(input);
  const type = asString(body.type) as JobType;
  const params = asObject(body.params ?? {}, "params");

  switch (type) {
    case "search":
      return validateSearch(params);
    case "collect-sales":
      return validateCollect(params);
    case "train-price":
    case "train-generator":
      return validateTraining(type, params);
    case "generate-ai":
      return validateGenerateAi(params);
    default:
      throw new Error("Неизвестный тип задачи");
  }
}

export function normalizeFavoriteInput(input: unknown): {
  username: string;
  source: "telegram" | "fragment";
  note?: string;
  price?: FavoritePrice;
} {
  const body = asObject(input);
  const username = asString(body.username).replace(/^@/, "").toLowerCase();
  const source = oneOf(body.source, ["telegram", "fragment"] as const, "telegram", "Источник");
  const note = asString(body.note);

  if (!/^[a-z][a-z0-9_]{3,31}$/.test(username) || username.includes("__") || username.endsWith("_")) {
    throw new Error("Некорректный юзернейм: 4–32 символа, первая — буква, далее a–z, 0–9 и _");
  }
  if (source === "telegram" && username.length < 5) {
    throw new Error("Обычный Telegram-юзернейм должен содержать минимум 5 символов");
  }
  if (note.length > 240) {
    throw new Error("Комментарий не должен быть длиннее 240 символов");
  }

  let price: FavoritePrice | undefined;
  if (body.price !== undefined && body.price !== null && body.price !== "") {
    const rawPrice = asObject(body.price, "Цена");
    const ton = asNumber(rawPrice.ton, Number.NaN, "Цена в TON", 0, 1_000_000_000_000, false);
    price = { ton };
    if (rawPrice.usd !== undefined) {
      price.usd = asNumber(rawPrice.usd, Number.NaN, "Цена в USD", 0, 1_000_000_000_000_000, false);
    }
    if (rawPrice.rub !== undefined) {
      price.rub = asNumber(rawPrice.rub, Number.NaN, "Цена в RUB", 0, 1_000_000_000_000_000, false);
    }
    const hasP10 = rawPrice.p10Ton !== undefined;
    const hasP90 = rawPrice.p90Ton !== undefined;
    if (hasP10 !== hasP90) {
      throw new Error("Ценовой интервал должен содержать и p10Ton, и p90Ton");
    }
    if (hasP10 && hasP90) {
      price.p10Ton = asNumber(
        rawPrice.p10Ton,
        Number.NaN,
        "P10 в TON",
        0,
        ton,
        false,
      );
      price.p90Ton = asNumber(
        rawPrice.p90Ton,
        Number.NaN,
        "P90 в TON",
        ton,
        1_000_000_000_000,
        false,
      );
    }
    if (rawPrice.confidence !== undefined) {
      price.confidence = oneOf(
        rawPrice.confidence,
        ["low", "medium", "high"] as const,
        "low",
        "Confidence",
      );
    }
    if (rawPrice.confidenceScore !== undefined) {
      price.confidenceScore = asNumber(
        rawPrice.confidenceScore,
        Number.NaN,
        "Confidence score",
        0,
        1,
        false,
      );
    }
    if (rawPrice.confidenceDefinition !== undefined) {
      price.confidenceDefinition = oneOf(
        rawPrice.confidenceDefinition,
        ["probability-within-2x", "heuristic-score"] as const,
        "heuristic-score",
        "Confidence definition",
      );
    }
    if (rawPrice.releaseGatePassed !== undefined) {
      if (typeof rawPrice.releaseGatePassed !== "boolean") {
        throw new Error("releaseGatePassed должен быть boolean");
      }
      price.releaseGatePassed = rawPrice.releaseGatePassed;
    }
    for (const [field, label] of [
      ["priceOutOfDistribution", "priceOutOfDistribution"],
      ["dataCurrent", "dataCurrent"],
    ] as const) {
      if (rawPrice[field] !== undefined) {
        if (typeof rawPrice[field] !== "boolean") {
          throw new Error(`${label} должен быть boolean`);
        }
        price[field] = rawPrice[field];
      }
    }
    if (rawPrice.outOfDistribution !== undefined) {
      if (typeof rawPrice.outOfDistribution !== "boolean") {
        throw new Error("outOfDistribution должен быть boolean");
      }
      if (
        price.priceOutOfDistribution !== undefined &&
        price.priceOutOfDistribution !== rawPrice.outOfDistribution
      ) {
        throw new Error(
          "outOfDistribution и priceOutOfDistribution не должны противоречить друг другу",
        );
      }
      price.priceOutOfDistribution = rawPrice.outOfDistribution;
    }
    if (rawPrice.oodScore !== undefined) {
      price.oodScore = asNumber(
        rawPrice.oodScore,
        Number.NaN,
        "Price OOD score",
        0,
        1,
        false,
      );
    }
    if (rawPrice.modelDisagreementLog !== undefined) {
      price.modelDisagreementLog = asNumber(
        rawPrice.modelDisagreementLog,
        Number.NaN,
        "Model disagreement",
        0,
        100,
        false,
      );
    }
    if (rawPrice.comparableEffectiveSampleSize !== undefined) {
      price.comparableEffectiveSampleSize = asNumber(
        rawPrice.comparableEffectiveSampleSize,
        Number.NaN,
        "Comparable effective sample size",
        0,
        1_000_000_000,
        false,
      );
    }
    for (const field of ["trainedAt", "trainedThrough"] as const) {
      if (rawPrice[field] === undefined) continue;
      const timestamp = asString(rawPrice[field]);
      const parsed = Date.parse(timestamp);
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
        throw new Error(`${field} должен быть каноническим ISO timestamp`);
      }
      price[field] = timestamp;
    }
    if (rawPrice.releaseGateReason !== undefined) {
      const reason = asString(rawPrice.releaseGateReason);
      if (reason.length === 0 || reason.length > 120) {
        throw new Error("releaseGateReason должен содержать 1–120 символов");
      }
      price.releaseGateReason = reason;
    }
    if (rawPrice.splitStrategy !== undefined) {
      price.splitStrategy = oneOf(
        rawPrice.splitStrategy,
        ["temporal-group", "group-random", "random"] as const,
        "random",
        "Split strategy",
      );
    }
    if (rawPrice.liquidity !== undefined) {
      const rawLiquidity = asObject(rawPrice.liquidity, "Ликвидность");
      const saleProbability90d = asNumber(
        rawLiquidity.saleProbability90d,
        Number.NaN,
        "Вероятность продажи за 90 дней",
        0,
        1,
        false,
      );
      if (typeof rawLiquidity.outOfDistribution !== "boolean") {
        throw new Error("liquidity.outOfDistribution должен быть boolean");
      }
      price.liquidity = {
        saleProbability90d,
        outOfDistribution: rawLiquidity.outOfDistribution,
      };
    }
  }

  const normalized = { username, source, note: note || undefined };
  return price ? { ...normalized, price } : normalized;
}
