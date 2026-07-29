import assert from "node:assert/strict";
import test from "node:test";
import { extractFeatures, FEATURE_NAMES } from "../src/priceModel/features.js";

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
