/**
 * Извлечение числовых признаков из юзернейма для модели оценки цены.
 *
 * Признаки — эвристики, которые обычно связывают с ценой на маркетплейсах
 * ников (короткие, читаемые, "брендовые" имена ценятся выше случайного
 * набора символов), но насколько каждая из них реально влияет на цену в
 * TON — вопрос, на который отвечает только обучение на реальных данных о
 * продажах (см. priceData/soldHistory.ts). Без этих данных модели просто
 * нечему учиться — признаки сами по себе цену не считают.
 */

const VOWELS = new Set("aeiou");

// Небольшой список токенов, которые на рынке крипто-ников заметно повышают
// спрос (тематика TON/крипто, короткие бренды, ходовые слова). Список
// неполный и субъективный — дополняйте по своим наблюдениям за реальными
// продажами.
const POPULAR_TOKENS = [
  "ton",
  "btc",
  "eth",
  "nft",
  "coin",
  "cash",
  "pay",
  "bank",
  "shop",
  "store",
  "game",
  "play",
  "bot",
  "ai",
  "crypto",
  "wallet",
  "market",
  "trade",
  "vip",
  "pro",
  "king",
  "boss",
  "top",
  "best",
  "gold",
  "moon",
];

export const FEATURE_NAMES = [
  "length",
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
  const startEndSameLetter = len > 0 && username[0] === username[len - 1] ? 1 : 0;

  return [
    len,
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
    startEndSameLetter,
  ];
}
