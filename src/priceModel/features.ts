/**
 * Извлечение числовых признаков из юзернейма для модели оценки цены.
 *
 * Признаки — эвристики, которые обычно связывают с ценой на маркетплейсах
 * ников (короткие, читаемые, "брендовые" имена ценятся выше случайного
 * набора символов), но насколько каждая из них реально влияет на цену в
 * TON — вопрос, на который отвечает только обучение на реальных данных о
 * продажах (см. priceData/soldHistory.ts). Без этих данных модели просто
 * нечему учиться — признаки сами по себе цену не считают.
 *
 * hasPopularToken (см. ниже) ловит только фиксированный список крипто/
 * брендовых токенов и пропускает обычные словарные слова — а именно они
 * оказались главным ценовым фактором в реальных топовых продажах (news,
 * auto, avia, ...). isDictionaryWord/containsDictionaryWord (см. ниже)
 * закрывают именно этот пробел через словарь из dictionaryWords.ts.
 */

import { POPULAR_TOKENS } from "../brandTokens.js";
import { DICTIONARY_WORDS } from "./dictionaryWords.js";

const VOWELS = new Set("aeiou");
// Substring matches against very short dictionary entries (3 chars) are noisy
// -- lots of unrelated names accidentally contain "cat" or "abs". Whole-name
// matches don't have that problem, so isDictionaryWord keeps the 3-char floor
// while containsDictionaryWord (substring, for longer/compound names) raises
// the bar to 4+ characters.
const MIN_SUBSTRING_WORD_LENGTH = 4;
// A full two-word split accounts for every character in the name, unlike
// containsDictionaryWord's substring scan -- there's no leftover junk that
// could make a short match coincidental. That makes 3-char halves (matching
// DICTIONARY_WORDS' own whole-word floor, e.g. "top"+"shop") safe here even
// though they'd be too noisy as a floating substring match.
const MIN_COMPOUND_PART_LENGTH = 3;

export const FEATURE_NAMES = [
  "length",
  "isLen4",
  "isLen5",
  "isLen6",
  "isLen7",
  "isLen8",
  "isLen9Plus",
  "hasDigit",
  "digitCount",
  "digitRatio",
  "vowelRatio",
  "uniqueCharRatio",
  "maxRepeatRun",
  "isPalindrome",
  "syllableRegularity",
  "hasPopularToken",
  "isDictionaryWord",
  "containsDictionaryWord",
  "isTwoWordCompound",
  "startEndSameLetter",
] as const;

export function extractFeatures(usernameRaw: string): number[] {
  const username = usernameRaw.toLowerCase();
  const len = username.length;

  const digitCount = (username.match(/\d/g) ?? []).length;
  const vowelCount = [...username].filter((c) => VOWELS.has(c)).length;
  const uniqueChars = new Set(username).size;

  let maxRun = len > 0 ? 1 : 0;
  let curRun = 1;
  for (let i = 1; i < len; i++) {
    if (username[i] === username[i - 1]) {
      curRun++;
      maxRun = Math.max(maxRun, curRun);
    } else {
      curRun = 1;
    }
  }

  const isPalindrome = len > 0 && username === [...username].reverse().join("") ? 1 : 0;

  // Грубая оценка "слоговой регулярности" — доля соседних пар символов, где
  // гласная чередуется с согласной (примерно так же, как строит буквы
  // generateReadable в generator.ts). У полностью случайных строк чередований
  // меньше, у произносимых слогов — почти всегда больше.
  let alternations = 0;
  for (let i = 1; i < len; i++) {
    const prevIsVowel = VOWELS.has(username[i - 1]);
    const curIsVowel = VOWELS.has(username[i]);
    if (prevIsVowel !== curIsVowel) alternations++;
  }
  const syllableRegularity = len > 1 ? alternations / (len - 1) : 0;

  const hasPopularToken = POPULAR_TOKENS.some((tkn) => username.includes(tkn)) ? 1 : 0;

  // Strip non-letters before dictionary lookups: "auto1" and "bank_88"
  // should still read as the words "auto"/"bank" with a numeric suffix,
  // rather than missing the match entirely because of the digits/underscore.
  const alphaOnly = username.replace(/[^a-z]/g, "");
  const isDictionaryWord = DICTIONARY_WORDS.has(alphaOnly) ? 1 : 0;

  // Generate substrings of the (short) username rather than scanning the
  // whole ~8.7k-word dictionary per call -- O(len^2) hash lookups instead of
  // O(dictionarySize) string scans.
  let containsDictionaryWord = isDictionaryWord;
  if (!containsDictionaryWord) {
    outer: for (let start = 0; start < alphaOnly.length; start++) {
      for (let end = start + MIN_SUBSTRING_WORD_LENGTH; end <= alphaOnly.length; end++) {
        if (DICTIONARY_WORDS.has(alphaOnly.slice(start, end))) {
          containsDictionaryWord = 1;
          break outer;
        }
      }
    }
  }

  const startEndSameLetter = len > 0 && username[0] === username[len - 1] ? 1 : 0;

  // Distinct from containsDictionaryWord: that fires on *any* embedded word,
  // padded by junk on either side ("auto99" contains "auto" but is mostly
  // digits). isTwoWordCompound is stricter -- it only fires when the *entire*
  // alphabetic content splits cleanly into two real words ("goldshop" =
  // "gold" + "shop") with nothing left over. That's exactly the pattern
  // generator.ts's compound mode deliberately produces, and it reads as an
  // intentional brand name rather than an accidental substring match.
  let isTwoWordCompound = 0;
  for (
    let split = MIN_COMPOUND_PART_LENGTH;
    split <= alphaOnly.length - MIN_COMPOUND_PART_LENGTH;
    split++
  ) {
    if (
      DICTIONARY_WORDS.has(alphaOnly.slice(0, split)) &&
      DICTIONARY_WORDS.has(alphaOnly.slice(split))
    ) {
      isTwoWordCompound = 1;
      break;
    }
  }

  return [
    len,
    len === 4 ? 1 : 0,
    len === 5 ? 1 : 0,
    len === 6 ? 1 : 0,
    len === 7 ? 1 : 0,
    len === 8 ? 1 : 0,
    len >= 9 ? 1 : 0,
    digitCount > 0 ? 1 : 0,
    digitCount,
    len > 0 ? digitCount / len : 0,
    len > 0 ? vowelCount / len : 0,
    len > 0 ? uniqueChars / len : 0,
    maxRun,
    isPalindrome,
    syllableRegularity,
    hasPopularToken,
    isDictionaryWord,
    containsDictionaryWord,
    isTwoWordCompound,
    startEndSameLetter,
  ];
}
