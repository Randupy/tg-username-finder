export type Source = "telegram" | "fragment";
export type SourceOption = Source | "both";

export type GenMode = "readable" | "random" | "word" | "translit" | "both" | "ai";

/**
 * Куда должно попасть пользовательское слово в режиме --mode word:
 * - start  — слово в начале, дальше случайные символы
 * - middle — слово окружено случайными символами с обеих сторон
 * - end    — случайные символы, затем слово в конце
 * - any    — без разницы, где именно (случайная позиция на каждой попытке)
 */
export type WordPosition = "start" | "middle" | "end" | "any";

/**
 * Политика по цифрам в юзернейме:
 * - exclude  — цифр быть не должно вообще
 * - allow    — цифры допускаются, но не обязательны
 * - require  — в юзернейме обязательно должна быть хотя бы одна цифра
 */
export type DigitsPolicy = "exclude" | "allow" | "require";

export interface SearchOptions {
  source: SourceOption;
  mode: GenMode;
  minLength: number;
  maxLength: number;
  digits: DigitsPolicy;
  count: number;
  charset?: string;
  /** Пользовательское слово для --mode word (например, "big") */
  word?: string;
  /** Где должно стоять слово внутри юзернейма — используется только с --mode word */
  wordPosition?: WordPosition;
  delayMs: number;
  outPath?: string;
  debug: boolean;
  dryRun: boolean;
  usePlaywright: boolean;
  /** Использовать старую HTML-эвристику вместо официального MTProto-метода */
  legacyWeb: boolean;
}

/**
 * true       — подтверждённо свободно
 * false      — подтверждённо занято
 * "unknown"  — не удалось определить (сеть/rate limit/недостаточно данных)
 * "invalid"  — имя в принципе не проходит по правилам источника
 *              (например, Telegram вернул USERNAME_INVALID) — источник
 *              вообще не рассматривал вопрос "занято/свободно"
 */
export type Availability = boolean | "unknown" | "invalid";

export interface CheckResult {
  username: string;
  source: Source;
  available: Availability;
  detail?: string;
  /** high — официальный детерминированный ответ источника, low — эвристика/скрейпинг */
  confidence: "high" | "low";
  checkedAt: string;
}

export interface GeneratedCandidate {
  username: string;
  mode: Exclude<GenMode, "both">;
}

export interface FavoriteEntry {
  username: string;
  source: Source;
  note?: string;
  price?: FavoritePrice;
  addedAt: string;
}

export interface FavoritePrice {
  /** Цена или оценка цены в TON. */
  ton: number;
  /** Конвертация по курсу на момент добавления, если она была доступна. */
  usd?: number;
  /** Конвертация по курсу на момент добавления, если она была доступна. */
  rub?: number;
}
