/**
 * Deterministic username features used by the price model.
 *
 * The first 20 coordinates intentionally retain the historic order. New
 * structural, lexical and hashed character features are appended so callers
 * using FEATURE_NAMES/extractFeatures remain source-compatible.
 */

import { POPULAR_TOKENS } from "../brandTokens.js";
import { DICTIONARY_WORDS } from "./dictionaryWords.js";

const VOWELS = new Set("aeiou");
const MIN_SUBSTRING_WORD_LENGTH = 4;
const MIN_COMPOUND_PART_LENGTH = 3;
const NGRAM_HASH_BUCKETS_PER_BANK = 32;
const HASH_BANK_A_SEED = 0x811c9dc5;
const HASH_BANK_B_SEED = 0x9e3779b9;
const MAX_HASHED_USERNAME_LENGTH = 256;

const LEGACY_FEATURE_NAMES = [
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

const EXTENDED_FEATURE_NAMES = [
  "alphaCount",
  "alphaRatio",
  "underscoreCount",
  "underscoreRatio",
  "startsWithUnderscore",
  "endsWithUnderscore",
  "underscoreGroupCount",
  "maxUnderscoreRun",
  "underscorePositionMean",
  "hasConsecutiveUnderscores",
  "startsWithDigit",
  "endsWithDigit",
  "leadingDigitCount",
  "trailingDigitCount",
  "digitGroupCount",
  "maxDigitRun",
  "digitPositionMean",
  "digitPositionStd",
  "letterGroupCount",
  "invalidCharCount",
  "adjacentRepeatCount",
  "adjacentRepeatRatio",
  "repeatedCharKindsRatio",
  "duplicateBigramRatio",
  "maxPeriodicRepeatRatio",
  "ascendingSequenceRatio",
  "descendingSequenceRatio",
  "maxOrdinalSequenceRunRatio",
  "keyboardAdjacencyRatio",
  "maxKeyboardRunRatio",
  "charEntropy",
  "bigramEntropy",
  "vowelRatioLetters",
  "vowelGroupDensity",
  "maxVowelRunRatio",
  "maxConsonantRunRatio",
  "pronounceabilityScore",
  "dictionaryTokenCount",
  "dictionaryTokenCoverage",
  "longestDictionaryTokenRatio",
  "dictionarySegmentationQuality",
  "commercialTokenCount",
  "commercialTokenCoverage",
  "bestCommercialTokenQuality",
  "separatedCommercialTokenRatio",
] as const;

const HASH_FEATURE_NAMES = [
  ...Array.from(
    { length: NGRAM_HASH_BUCKETS_PER_BANK },
    (_, index) => `charNgramHashA${String(index).padStart(2, "0")}`,
  ),
  ...Array.from(
    { length: NGRAM_HASH_BUCKETS_PER_BANK },
    (_, index) => `charNgramHashB${String(index).padStart(2, "0")}`,
  ),
] as const;

export const PRICE_FEATURE_NAMES = [
  ...LEGACY_FEATURE_NAMES,
  ...EXTENDED_FEATURE_NAMES,
  ...HASH_FEATURE_NAMES,
] as const;

/** Backward-compatible export used by the existing trainer. */
export const FEATURE_NAMES = PRICE_FEATURE_NAMES;

interface LexicalAnalysis {
  alphaRuns: string[];
  isDictionaryWord: number;
  containsDictionaryWord: number;
  isTwoWordCompound: number;
  dictionaryTokens: string[];
  dictionaryTokenCoverage: number;
  longestDictionaryTokenRatio: number;
  dictionarySegmentationQuality: number;
}

interface CommercialAnalysis {
  hasPopularToken: number;
  commercialTokenCount: number;
  commercialTokenCoverage: number;
  bestCommercialTokenQuality: number;
  separatedCommercialTokenRatio: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function canonicalize(usernameRaw: string): string {
  const normalized = usernameRaw.normalize("NFKC").toLowerCase();
  return [...normalized]
    .map((character) => (/^[a-z0-9_]$/.test(character) ? character : "?"))
    .join("");
}

function countGroups(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function maxRunMatching(characters: readonly string[], predicate: (character: string) => boolean): number {
  let current = 0;
  let maximum = 0;
  for (const character of characters) {
    if (predicate(character)) {
      current++;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function meanAndStdOfPositions(
  characters: readonly string[],
  predicate: (character: string) => boolean,
): [number, number] {
  if (characters.length <= 1) return [0, 0];

  const positions: number[] = [];
  for (let index = 0; index < characters.length; index++) {
    if (predicate(characters[index])) positions.push(index / (characters.length - 1));
  }
  if (positions.length === 0) return [0, 0];

  const mean = positions.reduce((sum, position) => sum + position, 0) / positions.length;
  const variance =
    positions.reduce((sum, position) => sum + (position - mean) ** 2, 0) / positions.length;
  return [mean, Math.sqrt(variance)];
}

function normalizedEntropy(items: readonly string[], alphabetSize: number): number {
  if (items.length <= 1) return 0;

  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / items.length;
    entropy -= probability * Math.log2(probability);
  }

  const maximumEntropy = Math.log2(Math.min(items.length, alphabetSize));
  return maximumEntropy > 0 ? clamp01(entropy / maximumEntropy) : 0;
}

function duplicateItemRatio(items: readonly string[]): number {
  if (items.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);

  let duplicateOccurrences = 0;
  for (const count of counts.values()) {
    if (count > 1) duplicateOccurrences += count - 1;
  }
  return duplicateOccurrences / items.length;
}

function maxPeriodicRepeatRatio(text: string): number {
  if (text.length < 2) return 0;

  let longestRepeatedSpan = 0;
  const maxPeriod = Math.floor(text.length / 2);
  for (let period = 1; period <= maxPeriod; period++) {
    for (let start = 0; start + 2 * period <= text.length; start++) {
      let span = period;
      while (
        start + span < text.length &&
        text[start + span] === text[start + (span % period)]
      ) {
        span++;
      }
      if (span >= 2 * period) longestRepeatedSpan = Math.max(longestRepeatedSpan, span);
    }
  }

  return longestRepeatedSpan / text.length;
}

function ordinalStep(previous: string, current: string): number {
  const bothLetters = /^[a-z]$/.test(previous) && /^[a-z]$/.test(current);
  const bothDigits = /^\d$/.test(previous) && /^\d$/.test(current);
  return bothLetters || bothDigits ? current.charCodeAt(0) - previous.charCodeAt(0) : 0;
}

function sequenceFeatures(characters: readonly string[]): [number, number, number] {
  if (characters.length <= 1) return [0, 0, 0];

  let ascending = 0;
  let descending = 0;
  let currentRun = 1;
  let maximumRun = 1;
  let previousStep = 0;

  for (let index = 1; index < characters.length; index++) {
    const step = ordinalStep(characters[index - 1], characters[index]);
    if (step === 1) ascending++;
    if (step === -1) descending++;

    if (Math.abs(step) === 1 && step === previousStep) {
      currentRun++;
    } else if (Math.abs(step) === 1) {
      currentRun = 2;
    } else {
      currentRun = 1;
    }
    maximumRun = Math.max(maximumRun, currentRun);
    previousStep = step;
  }

  const transitions = characters.length - 1;
  return [ascending / transitions, descending / transitions, maximumRun / characters.length];
}

const KEYBOARD_NEIGHBORS = (() => {
  const rows = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
  const neighbors = new Set<string>();
  for (const row of rows) {
    for (let index = 1; index < row.length; index++) {
      neighbors.add(`${row[index - 1]}${row[index]}`);
      neighbors.add(`${row[index]}${row[index - 1]}`);
    }
  }
  return neighbors;
})();

function keyboardFeatures(characters: readonly string[]): [number, number] {
  if (characters.length <= 1) return [0, 0];

  let adjacentPairs = 0;
  let currentRun = 1;
  let maximumRun = 1;
  for (let index = 1; index < characters.length; index++) {
    if (KEYBOARD_NEIGHBORS.has(`${characters[index - 1]}${characters[index]}`)) {
      adjacentPairs++;
      currentRun++;
      maximumRun = Math.max(maximumRun, currentRun);
    } else {
      currentRun = 1;
    }
  }

  return [adjacentPairs / (characters.length - 1), maximumRun / characters.length];
}

function bestFullDictionarySegmentation(run: string): string[] | null {
  if (run.length < MIN_COMPOUND_PART_LENGTH * 2) return null;

  const best: Array<string[] | null> = Array.from({ length: run.length + 1 }, () => null);
  best[0] = [];

  for (let end = 1; end <= run.length; end++) {
    for (let start = 0; start <= end - MIN_COMPOUND_PART_LENGTH; start++) {
      const prefix = best[start];
      if (prefix === null) continue;

      const word = run.slice(start, end);
      if (!DICTIONARY_WORDS.has(word)) continue;

      const candidate = [...prefix, word];
      const incumbent = best[end];
      if (
        incumbent === null ||
        candidate.length < incumbent.length ||
        (candidate.length === incumbent.length &&
          Math.min(...candidate.map((part) => part.length)) >
            Math.min(...incumbent.map((part) => part.length)))
      ) {
        best[end] = candidate;
      }
    }
  }

  const result = best[run.length];
  return result !== null && result.length >= 2 ? result : null;
}

function longestEmbeddedDictionaryWord(run: string): string | null {
  for (let length = run.length; length >= MIN_SUBSTRING_WORD_LENGTH; length--) {
    for (let start = 0; start + length <= run.length; start++) {
      const candidate = run.slice(start, start + length);
      if (DICTIONARY_WORDS.has(candidate)) return candidate;
    }
  }
  return null;
}

function hasTwoWordDictionarySplit(run: string): boolean {
  for (
    let split = MIN_COMPOUND_PART_LENGTH;
    split <= run.length - MIN_COMPOUND_PART_LENGTH;
    split++
  ) {
    if (
      DICTIONARY_WORDS.has(run.slice(0, split)) &&
      DICTIONARY_WORDS.has(run.slice(split))
    ) {
      return true;
    }
  }
  return false;
}

function analyzeLexicalContent(username: string): LexicalAnalysis {
  const alphaRuns = username.match(/[a-z]+/g) ?? [];
  const alphaCount = alphaRuns.reduce((sum, run) => sum + run.length, 0);
  const isDictionaryWord =
    alphaRuns.length === 1 && DICTIONARY_WORDS.has(alphaRuns[0]) ? 1 : 0;

  let containsDictionaryWord = isDictionaryWord;
  let isTwoWordCompound = 0;
  const dictionaryTokens: string[] = [];

  const fullSegmentations = alphaRuns.map((run) => bestFullDictionarySegmentation(run));

  if (
    alphaRuns.length === 2 &&
    alphaRuns.every(
      (run) => run.length >= MIN_COMPOUND_PART_LENGTH && DICTIONARY_WORDS.has(run),
    )
  ) {
    isTwoWordCompound = 1;
  } else if (alphaRuns.length === 1 && hasTwoWordDictionarySplit(alphaRuns[0])) {
    isTwoWordCompound = 1;
  }

  for (let index = 0; index < alphaRuns.length; index++) {
    const run = alphaRuns[index];
    if (DICTIONARY_WORDS.has(run)) {
      dictionaryTokens.push(run);
      containsDictionaryWord = 1;
      continue;
    }

    const segmentation = fullSegmentations[index];
    if (segmentation !== null) {
      dictionaryTokens.push(...segmentation);
      containsDictionaryWord = 1;
      continue;
    }

    const embedded = longestEmbeddedDictionaryWord(run);
    if (embedded !== null) {
      dictionaryTokens.push(embedded);
      containsDictionaryWord = 1;
    }
  }

  const coveredCharacters = dictionaryTokens.reduce((sum, token) => sum + token.length, 0);
  const longestToken = dictionaryTokens.reduce(
    (maximum, token) => Math.max(maximum, token.length),
    0,
  );
  const dictionaryTokenCoverage = clamp01(safeRatio(coveredCharacters, alphaCount));
  const longestDictionaryTokenRatio = safeRatio(longestToken, alphaCount);

  // Coverage rewards names made from known words; longer tokens and fewer
  // fragments raise confidence without pretending the alphabetically stored
  // dictionary still contains its source frequency ranks.
  const fragmentationPenalty =
    dictionaryTokens.length > 0 ? 1 / Math.sqrt(dictionaryTokens.length) : 0;
  const lengthConfidence = longestToken > 0 ? clamp01((longestToken - 2) / 6) : 0;
  const dictionarySegmentationQuality =
    dictionaryTokenCoverage * fragmentationPenalty * (0.5 + 0.5 * lengthConfidence);

  return {
    alphaRuns,
    isDictionaryWord,
    containsDictionaryWord,
    isTwoWordCompound,
    dictionaryTokens,
    dictionaryTokenCoverage,
    longestDictionaryTokenRatio,
    dictionarySegmentationQuality,
  };
}

function commercialMatchQuality(run: string, token: string): number {
  if (run === token) return 1;

  const index = run.indexOf(token);
  if (index < 0) return 0;

  const prefix = run.slice(0, index);
  const suffix = run.slice(index + token.length);
  const prefixIsWord =
    prefix.length >= MIN_COMPOUND_PART_LENGTH && DICTIONARY_WORDS.has(prefix);
  const suffixIsWord =
    suffix.length >= MIN_COMPOUND_PART_LENGTH && DICTIONARY_WORDS.has(suffix);

  if (prefix.length === 0 && suffixIsWord) return 0.85;
  if (suffix.length === 0 && prefixIsWord) return 0.85;
  if (prefixIsWord && suffixIsWord) return 0.72;

  return 0;
}

function analyzeCommercialContent(
  alphaRuns: readonly string[],
  alphaCount: number,
): CommercialAnalysis {
  const matchedTokens = new Set<string>();
  let coveredCharacters = 0;
  let bestCommercialTokenQuality = 0;
  let separatedMatches = 0;

  for (const run of alphaRuns) {
    for (const token of POPULAR_TOKENS) {
      const quality = commercialMatchQuality(run, token);
      if (quality <= 0) continue;

      const matchKey = `${run}:${token}`;
      if (!matchedTokens.has(matchKey)) {
        matchedTokens.add(matchKey);
        coveredCharacters += token.length;
      }
      if (quality === 1) separatedMatches++;
      bestCommercialTokenQuality = Math.max(bestCommercialTokenQuality, quality);
    }
  }

  return {
    hasPopularToken: bestCommercialTokenQuality >= 0.72 ? 1 : 0,
    commercialTokenCount: matchedTokens.size,
    commercialTokenCoverage: clamp01(safeRatio(coveredCharacters, alphaCount)),
    bestCommercialTokenQuality,
    separatedCommercialTokenRatio: safeRatio(separatedMatches, alphaRuns.length),
  };
}

function pronounceabilityFeatures(
  characters: readonly string[],
  alphaCount: number,
): [number, number, number, number, number] {
  const letters = characters.filter((character) => /^[a-z]$/.test(character));
  if (letters.length === 0) return [0, 0, 0, 0, 0];

  const vowelCount = letters.filter((letter) => VOWELS.has(letter)).length;
  const vowelGroups = countGroups(letters.join(""), /[aeiou]+/g);
  const maxVowelRun = maxRunMatching(letters, (letter) => VOWELS.has(letter));
  const maxConsonantRun = maxRunMatching(letters, (letter) => !VOWELS.has(letter));
  const vowelRatioLetters = vowelCount / letters.length;
  const vowelGroupDensity = vowelGroups / letters.length;
  const maxVowelRunRatio = maxVowelRun / letters.length;
  const maxConsonantRunRatio = maxConsonantRun / letters.length;

  let letterAlternations = 0;
  for (let index = 1; index < letters.length; index++) {
    if (VOWELS.has(letters[index - 1]) !== VOWELS.has(letters[index])) {
      letterAlternations++;
    }
  }
  const alternationRatio = safeRatio(letterAlternations, letters.length - 1);
  const vowelBalance = clamp01(1 - Math.abs(vowelRatioLetters - 0.42) / 0.42);
  const consonantClusterScore = clamp01(1 - Math.max(0, maxConsonantRun - 2) / 4);
  const vowelClusterScore = clamp01(1 - Math.max(0, maxVowelRun - 2) / 3);
  const letterPurity = safeRatio(alphaCount, characters.length);
  const pronounceabilityScore = clamp01(
    letterPurity *
      (0.32 * vowelBalance +
        0.28 * alternationRatio +
        0.25 * consonantClusterScore +
        0.15 * vowelClusterScore),
  );

  return [
    vowelRatioLetters,
    vowelGroupDensity,
    maxVowelRunRatio,
    maxConsonantRunRatio,
    pronounceabilityScore,
  ];
}

function stableHash(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function hashedCharacterNgrams(username: string): number[] {
  const bankA = Array<number>(NGRAM_HASH_BUCKETS_PER_BANK).fill(0);
  const bankB = Array<number>(NGRAM_HASH_BUCKETS_PER_BANK).fill(0);
  if (username.length === 0) return [...bankA, ...bankB];

  const boundedUsername = username.slice(0, MAX_HASHED_USERNAME_LENGTH);
  const padded = `^${boundedUsername}$`;
  const grams: string[] = [];

  for (const order of [2, 3, 4]) {
    for (let start = 0; start + order <= padded.length; start++) {
      grams.push(`${order}:${padded.slice(start, start + order)}`);
    }
  }

  for (const gram of grams) {
    const hashA = stableHash(gram, HASH_BANK_A_SEED);
    const hashB = stableHash(gram, HASH_BANK_B_SEED);
    const bucketA = hashA % NGRAM_HASH_BUCKETS_PER_BANK;
    const bucketB = hashB % NGRAM_HASH_BUCKETS_PER_BANK;
    bankA[bucketA] += (hashA & 0x80000000) === 0 ? 1 : -1;
    bankB[bucketB] += (hashB & 0x80000000) === 0 ? 1 : -1;
  }

  const scale = 1 / Math.sqrt(Math.max(1, grams.length));
  return [...bankA.map((value) => value * scale), ...bankB.map((value) => value * scale)];
}

export function extractPriceFeatures(usernameRaw: string): number[] {
  const username = canonicalize(usernameRaw);
  const characters = [...username];
  const len = characters.length;

  const digitCount = characters.filter((character) => /^\d$/.test(character)).length;
  const alphaCount = characters.filter((character) => /^[a-z]$/.test(character)).length;
  const vowelCount = characters.filter((character) => VOWELS.has(character)).length;
  const underscoreCount = characters.filter((character) => character === "_").length;
  const invalidCharCount = characters.filter((character) => character === "?").length;
  const characterCounts = new Map<string, number>();
  for (const character of characters) {
    characterCounts.set(character, (characterCounts.get(character) ?? 0) + 1);
  }
  const uniqueChars = characterCounts.size;

  let maxRepeatRun = len > 0 ? 1 : 0;
  let currentRepeatRun = 1;
  let adjacentRepeatCount = 0;
  for (let index = 1; index < len; index++) {
    if (characters[index] === characters[index - 1]) {
      adjacentRepeatCount++;
      currentRepeatRun++;
      maxRepeatRun = Math.max(maxRepeatRun, currentRepeatRun);
    } else {
      currentRepeatRun = 1;
    }
  }

  const repeatedCharacterKinds = [...characterCounts.values()].filter((count) => count > 1).length;

  const isPalindrome =
    len > 0 && username === [...characters].reverse().join("") ? 1 : 0;

  let alternations = 0;
  for (let index = 1; index < len; index++) {
    if (VOWELS.has(characters[index - 1]) !== VOWELS.has(characters[index])) {
      alternations++;
    }
  }
  const syllableRegularity = safeRatio(alternations, len - 1);

  const lexical = analyzeLexicalContent(username);
  const commercial = analyzeCommercialContent(lexical.alphaRuns, alphaCount);

  const underscoreGroupCount = countGroups(username, /_+/g);
  const digitGroupCount = countGroups(username, /\d+/g);
  const letterGroupCount = lexical.alphaRuns.length;
  const maxUnderscoreRun = maxRunMatching(characters, (character) => character === "_");
  const maxDigitRun = maxRunMatching(characters, (character) => /^\d$/.test(character));
  const leadingDigitCount = username.match(/^\d+/)?.[0].length ?? 0;
  const trailingDigitCount = username.match(/\d+$/)?.[0].length ?? 0;
  const [underscorePositionMean] = meanAndStdOfPositions(
    characters,
    (character) => character === "_",
  );
  const [digitPositionMean, digitPositionStd] = meanAndStdOfPositions(
    characters,
    (character) => /^\d$/.test(character),
  );

  const bigrams = Array.from(
    { length: Math.max(0, len - 1) },
    (_, index) => `${characters[index]}${characters[index + 1]}`,
  );
  const [ascendingSequenceRatio, descendingSequenceRatio, maxOrdinalSequenceRunRatio] =
    sequenceFeatures(characters);
  const [keyboardAdjacencyRatio, maxKeyboardRunRatio] = keyboardFeatures(characters);
  const [
    vowelRatioLetters,
    vowelGroupDensity,
    maxVowelRunRatio,
    maxConsonantRunRatio,
    pronounceabilityScore,
  ] = pronounceabilityFeatures(characters, alphaCount);

  const legacyFeatures = [
    len,
    len === 4 ? 1 : 0,
    len === 5 ? 1 : 0,
    len === 6 ? 1 : 0,
    len === 7 ? 1 : 0,
    len === 8 ? 1 : 0,
    len >= 9 ? 1 : 0,
    digitCount > 0 ? 1 : 0,
    digitCount,
    safeRatio(digitCount, len),
    safeRatio(vowelCount, len),
    safeRatio(uniqueChars, len),
    maxRepeatRun,
    isPalindrome,
    syllableRegularity,
    commercial.hasPopularToken,
    lexical.isDictionaryWord,
    lexical.containsDictionaryWord,
    lexical.isTwoWordCompound,
    len > 0 && characters[0] === characters[len - 1] ? 1 : 0,
  ];

  const extendedFeatures = [
    alphaCount,
    safeRatio(alphaCount, len),
    underscoreCount,
    safeRatio(underscoreCount, len),
    username.startsWith("_") ? 1 : 0,
    username.endsWith("_") ? 1 : 0,
    underscoreGroupCount,
    maxUnderscoreRun,
    underscorePositionMean,
    maxUnderscoreRun >= 2 ? 1 : 0,
    /^\d/.test(username) ? 1 : 0,
    /\d$/.test(username) ? 1 : 0,
    leadingDigitCount,
    trailingDigitCount,
    digitGroupCount,
    maxDigitRun,
    digitPositionMean,
    digitPositionStd,
    letterGroupCount,
    invalidCharCount,
    adjacentRepeatCount,
    safeRatio(adjacentRepeatCount, len - 1),
    safeRatio(repeatedCharacterKinds, uniqueChars),
    duplicateItemRatio(bigrams),
    maxPeriodicRepeatRatio(username),
    ascendingSequenceRatio,
    descendingSequenceRatio,
    maxOrdinalSequenceRunRatio,
    keyboardAdjacencyRatio,
    maxKeyboardRunRatio,
    normalizedEntropy(characters, 38),
    normalizedEntropy(bigrams, 38 * 38),
    vowelRatioLetters,
    vowelGroupDensity,
    maxVowelRunRatio,
    maxConsonantRunRatio,
    pronounceabilityScore,
    lexical.dictionaryTokens.length,
    lexical.dictionaryTokenCoverage,
    lexical.longestDictionaryTokenRatio,
    lexical.dictionarySegmentationQuality,
    commercial.commercialTokenCount,
    commercial.commercialTokenCoverage,
    commercial.bestCommercialTokenQuality,
    commercial.separatedCommercialTokenRatio,
  ];

  const features = [
    ...legacyFeatures,
    ...extendedFeatures,
    ...hashedCharacterNgrams(username),
  ];

  if (features.length !== PRICE_FEATURE_NAMES.length) {
    throw new Error(
      `Price feature schema mismatch: produced ${features.length}, expected ${PRICE_FEATURE_NAMES.length}`,
    );
  }
  if (!features.every(Number.isFinite)) {
    throw new Error("Price feature extraction produced a non-finite value");
  }

  return features;
}

/** Backward-compatible export used throughout the current project. */
export const extractFeatures = extractPriceFeatures;
