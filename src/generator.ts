import { POPULAR_TOKENS } from "./brandTokens.js";
import { DICTIONARY_WORDS } from "./priceModel/dictionaryWords.js";
import type { DigitsPolicy, GeneratedCandidate, SearchOptions, WordPosition } from "./types.js";
import { RUSSIAN_WORDS, transliterateRussian } from "./russianWords.js";

// Правила Telegram: 5–32 символа, начинается с буквы, только [a-zA-Z0-9_],
// без двойного подчёркивания, не заканчивается на "_".
// (Юзернеймы короче 5 символов через обычные настройки не регистрируются —
// они существуют только как "премиум"-объекты на Fragment.)
//
// ВАЖНО: это наша локальная копия правил — она нужна только чтобы не тратить
// проверки на заведомый мусор. Единственный источник истины — сам сервер
// Telegram (см. checkers/telegramMtproto.ts, account.checkUsername): если он
// вернёт USERNAME_INVALID на имя, прошедшее этот фильтр, значит наша копия
// правил чуть строже/мягче реальных — и результат покажет это явно, а не
// потеряется в "похоже на свободно", как было со скрейпингом.
//
// Раньше здесь был ещё и отдельный TELEGRAM_USERNAME_REGEX, дублирующий эту
// же логику другим способом и нигде не использовавшийся — источник путаницы
// при доработке, убрал в пользу одной функции.
export function isValidTelegramUsername(name: string): boolean {
  if (name.length < 5 || name.length > 32) return false;
  return hasValidUsernameShape(name);
}

/**
 * Four-character names can exist as Fragment collectibles, but are not valid
 * regular Telegram usernames. Keep this rule separate from Telegram validity.
 */
export function isValidFragmentCollectibleUsername(name: string): boolean {
  if (name.length < 4 || name.length > 32) return false;
  return hasValidUsernameShape(name);
}

function hasValidUsernameShape(name: string): boolean {
  if (!/^[a-zA-Z]/.test(name)) return false;
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return false;
  if (name.includes("__")) return false;
  if (name.endsWith("_")) return false;
  return true;
}

const CONSONANTS = "bcdfghjklmnprstvz"; // без редких/неудобных для произношения
const VOWELS = "aeiou";
const DEFAULT_CHARSET = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
type UsernameValidator = (name: string) => boolean;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

function requestedCount(count: number): number {
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function validRange(minLen: number, maxLen: number): { min: number; max: number } | null {
  if (!Number.isFinite(minLen) || !Number.isFinite(maxLen)) return null;
  const min = Math.ceil(minLen);
  const max = Math.floor(maxLen);
  return min > 0 && max >= min ? { min, max } : null;
}

function letterPool(charset?: string): string {
  const source = charset === undefined || charset.length === 0 ? DEFAULT_CHARSET : charset;
  return [...new Set(source.toLowerCase().match(/[a-z]/g) ?? [])].join("");
}

function syllable(): string {
  const c1 = pick(CONSONANTS.split(""));
  const v = pick(VOWELS.split(""));
  const c2 = Math.random() < 0.35 ? pick(CONSONANTS.split("")) : "";
  return c1 + v + c2;
}

function buildBySyllables(targetLen: number): string {
  let name = "";
  while (name.length < targetLen) {
    name += syllable();
  }
  return name.slice(0, targetLen);
}

/** Применяет политику по цифрам к готовому имени (может изменить длину). */
function applyDigits(base: string, policy: DigitsPolicy, minLen: number, maxLen: number): string {
  const hasDigit = /\d/.test(base);
  if (policy === "exclude") {
    return base.replace(/\d/g, "");
  }
  if (policy === "require" && !hasDigit) {
    const digitsCount = randomInt(1, 3);
    let digits = "";
    for (let i = 0; i < digitsCount; i++) digits += pick(DIGITS.split(""));
    let combined = base + digits;
    if (combined.length > maxLen) {
      combined = base.slice(0, Math.max(minLen - digits.length, 1)) + digits;
    }
    return combined;
  }
  return base; // allow — оставляем как есть
}

function clampToRange(name: string, minLen: number, maxLen: number): string | null {
  if (name.length > maxLen) name = name.slice(0, maxLen);
  if (name.length < minLen) return null; // короче минимума — отбрасываем
  return name;
}

export function generateReadable(
  count: number,
  minLen: number,
  maxLen: number,
  digits: DigitsPolicy,
  validator: UsernameValidator = isValidTelegramUsername,
): GeneratedCandidate[] {
  const targetCount = requestedCount(count);
  const range = validRange(minLen, maxLen);
  if (targetCount === 0 || !range) return [];

  const results = new Set<string>();
  let guard = 0;

  while (results.size < targetCount && guard < targetCount * 40) {
    guard++;
    const targetLen = randomInt(range.min, range.max);
    let name = buildBySyllables(targetLen);
    name = applyDigits(name, digits, range.min, range.max);
    const clamped = clampToRange(name, range.min, range.max);
    if (clamped && validator(clamped)) {
      results.add(clamped.toLowerCase());
    }
  }

  return [...results].map((username) => ({ username, mode: "readable" as const }));
}

export function generateRandom(
  count: number,
  minLen: number,
  maxLen: number,
  digits: DigitsPolicy,
  charset?: string,
  validator: UsernameValidator = isValidTelegramUsername,
): GeneratedCandidate[] {
  const targetCount = requestedCount(count);
  const range = validRange(minLen, maxLen);
  const letters = letterPool(charset);
  if (targetCount === 0 || !range || letters.length === 0) return [];

  const pool = digits === "exclude" ? letters : letters + DIGITS;
  const results = new Set<string>();
  let guard = 0;

  while (results.size < targetCount && guard < targetCount * 40) {
    guard++;
    const targetLen = randomInt(range.min, range.max);
    // первый символ всегда буква — так требует Telegram
    let name = pick(letters.split(""));
    for (let i = 1; i < targetLen; i++) {
      name += pick(pool.split(""));
    }
    name = applyDigits(name, digits, range.min, range.max);
    const clamped = clampToRange(name, range.min, range.max);
    if (clamped && validator(clamped)) {
      results.add(clamped.toLowerCase());
    }
  }

  return [...results].map((username) => ({ username, mode: "random" as const }));
}

function shuffle<T>(values: readonly T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Generates exact Latin transliterations of individual Russian nouns.
 * No combinations, separators, suffixes or clipped words are permitted.
 */
export function generateTranslit(
  count: number,
  minLen: number,
  maxLen: number,
  digits: DigitsPolicy,
  validator: UsernameValidator = isValidTelegramUsername,
): GeneratedCandidate[] {
  const targetCount = requestedCount(count);
  const range = validRange(minLen, maxLen);
  if (targetCount === 0 || !range || digits === "require") return [];

  const words = [...new Set(RUSSIAN_WORDS.map(transliterateRussian))].filter(Boolean);

  const results = new Set<string>();
  for (const candidate of shuffle(words)) {
    if (candidate.length < range.min || candidate.length > range.max) continue;
    if (!validator(candidate)) continue;
    results.add(candidate);
    if (results.size === targetCount) break;
  }

  return [...results].map((username) => ({ username, mode: "translit" as const }));
}

// Слова длиннее ~10 символов почти никогда не остаются словом целиком в
// пределах обычного диапазона длин юзернейма (5–32, но реалистичный спрос —
// 5–12), а для compound-режима им и вовсе не хватает места на вторую часть.
const DICTIONARY_POOL = [...DICTIONARY_WORDS];
const BRAND_TOKEN_POOL = [...new Set<string>(POPULAR_TOKENS)];

/**
 * dictionaryWords.ts — это сырой частотный список (google-10000-english),
 * а не курируемый словарь: в нём полно аббревиатур без единой гласной (tmp,
 * cms, jvc, dts) и обрывков, которые отлично работают как эвристика для
 * priceModel/features.ts (там ложные срабатывания на редких словах почти
 * не портят обучение на тысячах примеров), но режут глаз, если генератор
 * лепит из них составные имена напрямую. Простой фонетический фильтр — есть
 * хотя бы одна гласная и нет разбега согласных длиннее трёх подряд —
 * отсеивает большую часть такого шума, не требуя вручную размеченного
 * словаря частей речи.
 */
function looksPronounceable(word: string): boolean {
  if (word.length < 3) return false;
  let vowelCount = 0;
  let consonantRun = 0;
  let maxConsonantRun = 0;
  for (const ch of word) {
    if (VOWELS.includes(ch)) {
      vowelCount++;
      consonantRun = 0;
    } else {
      consonantRun++;
      maxConsonantRun = Math.max(maxConsonantRun, consonantRun);
    }
  }
  return vowelCount > 0 && vowelCount / word.length >= 0.2 && maxConsonantRun <= 3;
}

const COMPOUND_DICTIONARY_POOL = DICTIONARY_POOL.filter(
  (w) => w.length >= 3 && w.length <= 8 && looksPronounceable(w),
);

/**
 * Пытается пристроить требуемую цифру в конец уже готового "чистого" слова
 * (словарного или составного), не обрезая и не портя само слово — в отличие
 * от applyDigits, которая рассчитана на бессмысленные случайные строки и при
 * нехватке места готова обрезать их с потерей смысла. Возвращает null, если
 * места под цифру не осталось.
 */
function appendRequiredDigitSuffix(word: string, maxLen: number): string | null {
  if (/\d/.test(word) || word.length >= maxLen) return null;
  const digitsCount = Math.min(randomInt(1, 2), maxLen - word.length);
  let suffix = "";
  for (let i = 0; i < digitsCount; i++) suffix += pick(DIGITS.split(""));
  return word + suffix;
}

/**
 * Генерирует кандидатов, которые сами по себе являются настоящим,
 * узнаваемым английским словом (опционально — с цифровым суффиксом при
 * --digits require).
 *
 * Зачем это нужно: isDictionaryWord — один из главных факторов цены в
 * priceModel/features.ts (см. комментарий там же: news/auto/bank/avia —
 * реальные топовые продажи Fragment), но ни один другой режим генератора не
 * производит такие имена намеренно — readable строит слоги, random выдаёт
 * шум, а word требует, чтобы слово ввёл сам пользователь. Этот режим
 * закрывает разрыв напрямую: генератор целится в тот же сигнал, который
 * модель цены уже умеет распознавать.
 */
export function generateDictionary(
  count: number,
  minLen: number,
  maxLen: number,
  digits: DigitsPolicy,
  validator: UsernameValidator = isValidTelegramUsername,
): GeneratedCandidate[] {
  const targetCount = requestedCount(count);
  const range = validRange(minLen, maxLen);
  if (targetCount === 0 || !range) return [];

  const results = new Set<string>();
  for (const word of shuffle(DICTIONARY_POOL)) {
    if (results.size >= targetCount) break;

    let candidate: string | null = word;
    if (digits === "require") {
      candidate = appendRequiredDigitSuffix(word, range.max);
    }
    if (!candidate) continue;
    if (candidate.length < range.min || candidate.length > range.max) continue;
    if (!validator(candidate)) continue;
    results.add(candidate);
  }

  return [...results].map((username) => ({ username, mode: "dictionary" as const }));
}

/**
 * Комбинирует два коротких токена — словарные слова и/или брендовые токены
 * из brandTokens.ts (ton, gold, top, shop, pro, ...) — в один составной
 * юзернейм ("goldshop", "topauto", "probank"). Целится сразу в два сигнала
 * ценовой модели: hasPopularToken и новый isTwoWordCompound, вместо того
 * чтобы полагаться на случай в слоговом или полностью случайном генераторе.
 *
 * Части намеренно не режутся и не искажаются политикой цифр — цифра (при
 * --digits require) может только дописываться в конец уже готового
 * составного слова, а не встраиваться в середину.
 */
export function generateCompound(
  count: number,
  minLen: number,
  maxLen: number,
  digits: DigitsPolicy,
  validator: UsernameValidator = isValidTelegramUsername,
): GeneratedCandidate[] {
  const targetCount = requestedCount(count);
  const range = validRange(minLen, maxLen);
  if (targetCount === 0 || !range) return [];

  // Каждой части нужно оставить место хотя бы для 2-символьного партнёра.
  const maxPartLen = range.max - 2;
  const dictionaryParts = COMPOUND_DICTIONARY_POOL.filter((w) => w.length <= maxPartLen);
  const brandParts = BRAND_TOKEN_POOL.filter((w) => w.length <= maxPartLen);
  const anyParts = [...new Set([...dictionaryParts, ...brandParts])];
  if (anyParts.length < 2) return [];

  const results = new Set<string>();
  let guard = 0;
  const maxGuard = targetCount * 200;

  while (results.size < targetCount && guard < maxGuard) {
    guard++;
    // Половину попыток отдаём под "курируемый токен + словарное слово" —
    // это надёжнее читается как осмысленный бренд (goldshop, topauto), чем
    // случайная пара из всего 8.7k-словного частотного списка. Вторую
    // половину оставляем полностью словарной для разнообразия.
    const useBrandPair = brandParts.length > 0 && Math.random() < 0.5;
    const first = useBrandPair ? pick(brandParts) : pick(anyParts);
    const second = useBrandPair && dictionaryParts.length > 0 ? pick(dictionaryParts) : pick(anyParts);
    const [a, b] = Math.random() < 0.5 ? [first, second] : [second, first];
    if (a === b) continue;

    let candidate: string | null = a + b;
    if (candidate.length > range.max) continue;
    if (digits === "require") {
      candidate = appendRequiredDigitSuffix(candidate, range.max);
    }
    if (!candidate) continue;
    if (candidate.length < range.min || candidate.length > range.max) continue;
    if (!validator(candidate)) continue;
    results.add(candidate);
  }

  return [...results].map((username) => ({ username, mode: "compound" as const }));
}

/**
 * Пытается воткнуть одну цифру в filler-символы (prefix/suffix), не трогая
 * само пользовательское слово и не ломая правило "первый символ — буква".
 * Возвращает null, если безопасного места под цифру нет (например, слово
 * занимает весь username целиком) — тогда кандидат просто пропускается.
 */
function insertDigitSafely(prefix: string, suffix: string): { prefix: string; suffix: string } | null {
  if (suffix.length > 0) {
    const idx = randomInt(0, suffix.length - 1);
    return { prefix, suffix: suffix.slice(0, idx) + pick(DIGITS.split("")) + suffix.slice(idx + 1) };
  }
  if (prefix.length > 1) {
    // индекс 0 не трогаем — это первый символ юзернейма, должен остаться буквой
    const idx = randomInt(1, prefix.length - 1);
    return { prefix: prefix.slice(0, idx) + pick(DIGITS.split("")) + prefix.slice(idx + 1), suffix };
  }
  return null;
}

/**
 * Генерирует юзернеймы, обязательно содержащие пользовательское слово в
 * заданной позиции — остальное заполняется случайными буквами (и, в
 * зависимости от --digits, цифрами).
 *
 * Политика цифр применяется только к filler-символам, никогда не к самому
 * слову — иначе "big" мог бы превратиться в "b1g", а пользователь явно
 * вводил конкретное слово, которое должно остаться как есть.
 */
export function generateWithWord(
  count: number,
  minLen: number,
  maxLen: number,
  digits: DigitsPolicy,
  word: string,
  position: WordPosition,
  charset?: string,
  validator: UsernameValidator = isValidTelegramUsername,
): GeneratedCandidate[] {
  const targetCount = requestedCount(count);
  const range = validRange(minLen, maxLen);
  const letters = letterPool(charset);
  if (targetCount === 0 || !range || letters.length === 0) return [];

  const pool = digits === "exclude" ? letters : letters + DIGITS;
  const w = word.toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(w)) return [];

  const results = new Set<string>();
  let guard = 0;

  while (results.size < targetCount && guard < targetCount * 60) {
    guard++;
    const lowBound = Math.max(range.min, w.length);
    if (lowBound > range.max) break; // слово длиннее --max-length — сгенерировать нечего

    const targetLen = randomInt(lowBound, range.max);
    const fillerLen = targetLen - w.length;

    let prefixLen: number;
    if (position === "middle" && fillerLen < 2) {
      continue;
    } else if (fillerLen === 0) {
      prefixLen = 0;
    } else if (position === "start") {
      prefixLen = 0;
    } else if (position === "end") {
      prefixLen = fillerLen;
    } else if (position === "middle") {
      prefixLen = randomInt(1, fillerLen - 1);
    } else {
      prefixLen = randomInt(0, fillerLen); // any — случайная позиция
    }
    const suffixLen = fillerLen - prefixLen;

    const randChar = () => pick(pool.split(""));
    let prefix = "";
    for (let i = 0; i < prefixLen; i++) prefix += randChar();
    let suffix = "";
    for (let i = 0; i < suffixLen; i++) suffix += randChar();

    // если слово не в самом начале, первый символ юзернейма — из prefix,
    // и он обязан быть буквой (правило Telegram)
    if (prefix.length > 0 && !/[a-zA-Z]/.test(prefix[0])) {
      prefix = pick(letters.split("")) + prefix.slice(1);
    }

    if (digits === "require" && !/\d/.test(prefix + suffix)) {
      const patched = insertDigitSafely(prefix, suffix);
      if (!patched) continue;
      prefix = patched.prefix;
      suffix = patched.suffix;
    }

    const name = prefix + w + suffix;
    if (validator(name)) {
      results.add(name.toLowerCase());
    }
  }

  return [...results].map((username) => ({ username, mode: "word" as const }));
}

export function generateCandidates(opts: SearchOptions): GeneratedCandidate[] {
  const { source, mode, digits, charset, word, wordPosition } = opts;
  const count = requestedCount(opts.count);
  if (count === 0) return [];

  // Four-character candidates only make sense when Fragment is the sole
  // destination. Telegram and combined checks retain Telegram's minimum of 5.
  const minimumLength = source === "fragment" ? 4 : 5;
  const minLength = Math.max(Math.ceil(opts.minLength), minimumLength);
  const maxLength = Math.min(Math.floor(opts.maxLength), 32);
  if (!Number.isFinite(minLength) || !Number.isFinite(maxLength) || minLength > maxLength) return [];

  const validator =
    source === "fragment" ? isValidFragmentCollectibleUsername : isValidTelegramUsername;

  if (mode === "word") {
    if (!word) return []; // валидируется в cli.ts до вызова — сюда попасть не должно
    return generateWithWord(
      count,
      minLength,
      maxLength,
      digits,
      word,
      wordPosition ?? "any",
      charset,
      validator,
    );
  }

  if (mode === "readable") {
    return generateReadable(count, minLength, maxLength, digits, validator);
  }
  if (mode === "random") {
    return generateRandom(count, minLength, maxLength, digits, charset, validator);
  }
  if (mode === "translit") {
    return generateTranslit(count, minLength, maxLength, digits, validator);
  }
  if (mode === "dictionary") {
    return generateDictionary(count, minLength, maxLength, digits, validator);
  }
  if (mode === "compound") {
    return generateCompound(count, minLength, maxLength, digits, validator);
  }
  if (mode !== "both") return [];

  // Generate enough from either family to compensate when the other family has
  // an impossible/tiny search space, then interleave to retain mode diversity.
  const readable = generateReadable(count, minLength, maxLength, digits, validator);
  const random = generateRandom(count, minLength, maxLength, digits, charset, validator);
  const out: GeneratedCandidate[] = [];
  for (let i = 0; i < Math.max(readable.length, random.length); i++) {
    if (i < readable.length) out.push(readable[i]);
    if (i < random.length) out.push(random[i]);
  }

  const seen = new Set<string>();
  const deduped: GeneratedCandidate[] = [];
  for (const candidate of out) {
    if (seen.has(candidate.username)) continue;
    seen.add(candidate.username);
    deduped.push(candidate);
    if (deduped.length === count) break;
  }
  return deduped;
}
