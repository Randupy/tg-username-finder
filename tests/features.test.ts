import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFeatures,
  extractPriceFeatures,
  FEATURE_NAMES,
  PRICE_FEATURE_NAMES,
} from "../src/priceModel/features.js";

function featureMap(username: string): Record<string, number> {
  const values = extractFeatures(username);
  assert.equal(values.length, FEATURE_NAMES.length, "extractFeatures must return one value per FEATURE_NAMES entry");
  return Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, values[i]]));
}

test("isLen4 is set only for 4-character usernames", () => {
  assert.equal(featureMap("auto").isLen4, 1);
  assert.equal(featureMap("auto").isLen5, 0);
  assert.equal(featureMap("acorn").isLen4, 0);
  assert.equal(featureMap("acorn").isLen5, 1);
});

test("isDictionaryWord fires on an exact whole-username match", () => {
  // These are real Fragment sales from data/sold-history.json (auto, bank,
  // news all sold for hundreds of thousands of TON) that hasPopularToken
  // alone does not recognize, since it only covers a small crypto/brand list.
  assert.equal(featureMap("auto").isDictionaryWord, 1);
  assert.equal(featureMap("bank").isDictionaryWord, 1);
  assert.equal(featureMap("news").isDictionaryWord, 1);
  assert.equal(featureMap("zwbig").isDictionaryWord, 0);
});

test("isDictionaryWord ignores trailing digits/underscores", () => {
  assert.equal(featureMap("auto1").isDictionaryWord, 1);
  assert.equal(featureMap("bank_88").isDictionaryWord, 1);
});

test("dictionary lookup preserves separator boundaries instead of joining fragments", () => {
  assert.equal(featureMap("cork").isDictionaryWord, 1);
  assert.equal(featureMap("cor_k").isDictionaryWord, 0);
  assert.equal(featureMap("cor_k").containsDictionaryWord, 0);

  assert.equal(featureMap("navy").isDictionaryWord, 1);
  assert.equal(featureMap("n_avy").isDictionaryWord, 0);
  assert.equal(featureMap("n_avy").containsDictionaryWord, 0);
  assert.equal(featureMap("a_u_t_o").isDictionaryWord, 0);
  assert.equal(featureMap("a_u_t_o").containsDictionaryWord, 0);
});

test("containsDictionaryWord fires on a compound of two dictionary words", () => {
  assert.equal(featureMap("goldrush").containsDictionaryWord, 1);
  // Whole-word matches also count as "contains".
  assert.equal(featureMap("auto").containsDictionaryWord, 1);
});

test("containsDictionaryWord ignores matches shorter than the substring floor", () => {
  // "big" is a real 3-letter word, but the substring floor is 4 characters,
  // so an unrelated 5-letter string that merely ends in "big" should not
  // trigger a false-positive dictionary signal.
  assert.equal(featureMap("zwbig").containsDictionaryWord, 0);
});

test("containsDictionaryWord is 0 for a name with no embedded dictionary word", () => {
  assert.equal(featureMap("qzxjkv").containsDictionaryWord, 0);
});

test("isTwoWordCompound fires only when the whole name splits cleanly into two dictionary words", () => {
  assert.equal(featureMap("goldrush").isTwoWordCompound, 1);
  assert.equal(featureMap("topshop").isTwoWordCompound, 1);
});

test("isTwoWordCompound is 0 for a single dictionary word, unlike containsDictionaryWord", () => {
  // "auto" is a whole dictionary word (isDictionaryWord=1, containsDictionaryWord=1)
  // but there is no way to split it into two separate dictionary words.
  assert.equal(featureMap("auto").isDictionaryWord, 1);
  assert.equal(featureMap("auto").isTwoWordCompound, 0);
});

test("isTwoWordCompound is 0 when a dictionary word is merely embedded in junk", () => {
  // containsDictionaryWord fires here ("auto" is embedded), but the leftover
  // "zw"/"z" on either side are not dictionary words themselves, so this is
  // not a clean two-word compound.
  assert.equal(featureMap("zwautoz").containsDictionaryWord, 1);
  assert.equal(featureMap("zwautoz").isTwoWordCompound, 0);
});

test("new and legacy feature APIs are aliases with a stable finite schema", () => {
  assert.strictEqual(FEATURE_NAMES, PRICE_FEATURE_NAMES);
  assert.strictEqual(extractFeatures, extractPriceFeatures);
  assert.equal(new Set(PRICE_FEATURE_NAMES).size, PRICE_FEATURE_NAMES.length);

  for (const username of [
    "",
    "a",
    "___",
    "123",
    "cor_k",
    "n_avy",
    "юзер",
    "a".repeat(300),
  ]) {
    const values = extractPriceFeatures(username);
    assert.equal(values.length, PRICE_FEATURE_NAMES.length);
    assert.ok(values.every(Number.isFinite), `${username} produced a non-finite feature`);
    assert.deepEqual(values, extractPriceFeatures(username), `${username} was not deterministic`);
  }
});

test("underscore and digit placement is represented explicitly", () => {
  const separated = featureMap("_ab__12_");
  assert.equal(separated.underscoreCount, 4);
  assert.equal(separated.startsWithUnderscore, 1);
  assert.equal(separated.endsWithUnderscore, 1);
  assert.equal(separated.underscoreGroupCount, 3);
  assert.equal(separated.maxUnderscoreRun, 2);
  assert.equal(separated.hasConsecutiveUnderscores, 1);
  assert.equal(separated.digitGroupCount, 1);
  assert.equal(separated.maxDigitRun, 2);

  const digitsAtEdges = featureMap("12ab34");
  assert.equal(digitsAtEdges.startsWithDigit, 1);
  assert.equal(digitsAtEdges.endsWithDigit, 1);
  assert.equal(digitsAtEdges.leadingDigitCount, 2);
  assert.equal(digitsAtEdges.trailingDigitCount, 2);
  assert.equal(digitsAtEdges.digitGroupCount, 2);
});

test("repeat, ordinal sequence, keyboard and pronounceability signals distinguish patterns", () => {
  assert.equal(featureMap("abcabc").maxPeriodicRepeatRatio, 1);
  assert.equal(featureMap("abcdef").ascendingSequenceRatio, 1);
  assert.equal(featureMap("fedcba").descendingSequenceRatio, 1);
  assert.equal(featureMap("qwerty").keyboardAdjacencyRatio, 1);
  assert.ok(
    featureMap("marina").pronounceabilityScore > featureMap("qzxjkv").pronounceabilityScore,
  );
});

test("commercial tokens require a clean boundary or a high-quality compound", () => {
  assert.equal(featureMap("ai").hasPopularToken, 1);
  assert.equal(featureMap("ai_shop").commercialTokenCount, 2);
  assert.equal(featureMap("bestshop").bestCommercialTokenQuality, 0.85);
  assert.equal(featureMap("chair").hasPopularToken, 0);
  assert.equal(featureMap("stone").hasPopularToken, 0);
});

function hashBank(username: string, bank: "A" | "B"): number[] {
  const features = featureMap(username);
  return PRICE_FEATURE_NAMES.filter((name) => name.startsWith(`charNgramHash${bank}`)).map(
    (name) => features[name],
  );
}

test("two independent n-gram hash banks are deterministic and separator-sensitive", () => {
  for (const [withSeparator, joined] of [
    ["cor_k", "cork"],
    ["n_avy", "navy"],
  ] as const) {
    assert.notDeepEqual(hashBank(withSeparator, "A"), hashBank(joined, "A"));
    assert.notDeepEqual(hashBank(withSeparator, "B"), hashBank(joined, "B"));
  }

  const usernames = ["alpha", "alp_ha", "alpha1", "1alpha", "alphanumeric", "qzxjkv"];
  for (const bank of ["A", "B"] as const) {
    const signatures = usernames.map((username) => JSON.stringify(hashBank(username, bank)));
    assert.equal(new Set(signatures).size, usernames.length);
  }
});
