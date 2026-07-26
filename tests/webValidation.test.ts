import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFavoriteInput,
  validateJobRequest,
} from "../src/web/validation.js";

test("builds a safe search CLI invocation from defaults", () => {
  const job = validateJobRequest({ type: "search", params: {} });

  assert.deepEqual(job, {
    type: "search",
    args: [
      "search",
      "--source",
      "both",
      "--mode",
      "both",
      "--min-length",
      "5",
      "--max-length",
      "8",
      "--digits",
      "exclude",
      "--count",
      "20",
      "--delay",
      "2000",
    ],
    expectsResult: true,
    totalUnits: 20,
  });
});

test("normalizes word-search values and emits only recognized flags", () => {
  const job = validateJobRequest({
    type: "search",
    params: {
      source: "telegram",
      mode: "word",
      minLength: "6",
      maxLength: 10,
      digits: "allow",
      count: "7",
      delayMs: 250,
      charset: "AaBbA",
      word: " Alpha9 ",
      wordPosition: "end",
      debug: true,
      usePlaywright: true,
      legacyWeb: true,
      estimatePrice: true,
      dryRun: true,
      out: "../../must-not-be-forwarded.json",
    },
  });

  assert.deepEqual(job.args, [
    "search",
    "--source",
    "telegram",
    "--mode",
    "word",
    "--min-length",
    "6",
    "--max-length",
    "10",
    "--digits",
    "allow",
    "--count",
    "7",
    "--delay",
    "250",
    "--charset",
    "ab",
    "--word",
    "alpha9",
    "--word-position",
    "end",
    "--debug",
    "--playwright",
    "--legacy-web",
    "--estimate-price",
    "--dry-run",
  ]);
  assert.equal(job.expectsResult, true);
  assert.equal(job.totalUnits, 7);
  assert.equal(job.args.includes("../../must-not-be-forwarded.json"), false);
});

test("accepts the Russian transliteration search mode", () => {
  const job = validateJobRequest({
    type: "search",
    params: {
      mode: "translit",
      count: 10,
      minLength: 5,
      maxLength: 12,
      delayMs: 500,
    },
  });

  assert.equal(job.args[job.args.indexOf("--mode") + 1], "translit");
});

test("rejects malformed and out-of-range job requests", () => {
  const invalidRequests: unknown[] = [
    null,
    [],
    { type: "unknown", params: {} },
    { type: "search", params: { minLength: 9, maxLength: 8 } },
    { type: "search", params: { count: 0 } },
    { type: "search", params: { charset: "abc;rm" } },
    { type: "search", params: { mode: "word", word: "../bad" } },
    { type: "collect-sales", params: { pages: 51 } },
    { type: "train-price", params: { epochs: 1.5 } },
    { type: "generate-ai", params: { temperature: 3.1 } },
  ];

  for (const request of invalidRequests) {
    assert.throws(() => validateJobRequest(request));
  }
});

test("builds collection, training, and AI-generation jobs", () => {
  assert.deepEqual(
    validateJobRequest({
      type: "collect-sales",
      params: { pages: 4, delayMs: 500, debug: true },
    }),
    {
      type: "collect-sales",
      args: ["collect-sales", "--pages", "4", "--delay", "500", "--debug"],
      expectsResult: false,
      totalUnits: 4,
    },
  );

  assert.deepEqual(
    validateJobRequest({ type: "train-generator", params: { epochs: "12" } }),
    {
      type: "train-generator",
      args: ["train-generator", "--epochs", "12"],
      expectsResult: false,
      totalUnits: 12,
    },
  );

  assert.deepEqual(
    validateJobRequest({
      type: "generate-ai",
      params: {
        count: 5,
        minLength: 6,
        maxLength: 9,
        temperature: "0.65",
        delayMs: 750,
        source: "fragment",
        estimatePrice: true,
      },
    }),
    {
      type: "generate-ai",
      args: [
        "generate-ai",
        "--count",
        "5",
        "--min-length",
        "6",
        "--max-length",
        "9",
        "--temperature",
        "0.65",
        "--delay",
        "750",
        "--source",
        "fragment",
        "--estimate-price",
      ],
      expectsResult: true,
      totalUnits: 5,
    },
  );
});

test("normalizes favorite input and enforces source-specific constraints", () => {
  assert.deepEqual(
    normalizeFavoriteInput({
      username: " @Alpha_1 ",
      source: "telegram",
      note: "  promising  ",
      price: { ton: 125.5, usd: 380, rub: 29_000 },
    }),
    {
      username: "alpha_1",
      source: "telegram",
      note: "promising",
      price: { ton: 125.5, usd: 380, rub: 29_000 },
    },
  );

  assert.deepEqual(
    normalizeFavoriteInput({ username: "Rare", source: "fragment", note: " " }),
    {
      username: "rare",
      source: "fragment",
      note: undefined,
    },
  );

  assert.throws(() =>
    normalizeFavoriteInput({ username: "rare", source: "telegram" }),
  );
  assert.throws(() =>
    normalizeFavoriteInput({ username: "bad__name", source: "fragment" }),
  );
  assert.throws(() =>
    normalizeFavoriteInput({
      username: "validname",
      source: "telegram",
      note: "x".repeat(241),
    }),
  );
  assert.throws(() =>
    normalizeFavoriteInput({
      username: "validname",
      source: "telegram",
      price: { ton: -1 },
    }),
  );
});
