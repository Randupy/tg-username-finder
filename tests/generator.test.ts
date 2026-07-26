import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCandidates,
  generateWithWord,
  isValidFragmentCollectibleUsername,
  isValidTelegramUsername,
} from "../src/generator.js";
import type { SearchOptions } from "../src/types.js";

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    source: "both",
    mode: "both",
    minLength: 5,
    maxLength: 8,
    digits: "exclude",
    count: 5,
    delayMs: 0,
    debug: false,
    dryRun: true,
    usePlaywright: false,
    legacyWeb: false,
    ...overrides,
  };
}

test("mode=both never returns more than count, including odd counts", () => {
  const candidates = generateCandidates(options({ count: 5 }));

  assert.equal(candidates.length, 5);
  assert.equal(new Set(candidates.map((candidate) => candidate.username)).size, 5);
});

test("mode=both can fill from one generator when the other search space is tiny", () => {
  const candidates = generateCandidates(
    options({ count: 4, minLength: 5, maxLength: 5, charset: "a" }),
  );

  assert.equal(candidates.length, 4);
  assert.ok(candidates.some((candidate) => candidate.mode === "readable"));
});

test("four-character candidates are exclusive to Fragment", () => {
  const fragment = generateCandidates(
    options({
      source: "fragment",
      mode: "random",
      count: 1,
      minLength: 4,
      maxLength: 4,
      charset: "a",
    }),
  );

  assert.deepEqual(fragment.map((candidate) => candidate.username), ["aaaa"]);
  assert.equal(isValidFragmentCollectibleUsername("aaaa"), true);
  assert.equal(isValidTelegramUsername("aaaa"), false);

  assert.deepEqual(
    generateCandidates(
      options({
        source: "both",
        mode: "random",
        count: 1,
        minLength: 4,
        maxLength: 4,
        charset: "a",
      }),
    ),
    [],
  );
});

test("impossible generator inputs return an empty result", () => {
  assert.deepEqual(
    generateCandidates(options({ mode: "random", charset: "123_", count: 2 })),
    [],
  );
  assert.deepEqual(generateCandidates(options({ count: 0 })), []);
  assert.deepEqual(generateCandidates(options({ minLength: 9, maxLength: 8 })), []);
  assert.deepEqual(generateWithWord(2, 5, 5, "exclude", "hello", "middle"), []);
});
