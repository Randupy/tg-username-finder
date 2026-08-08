import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPriceQualifiedCandidates,
  type PriceFilterDependencies,
} from "../src/cli.js";
import type { PricePrediction } from "../src/priceModel/predict.js";
import type { GeneratedCandidate } from "../src/types.js";

function candidate(username: string): GeneratedCandidate {
  return { username, mode: "readable" };
}

function prediction(p50Ton: number, p90Ton: number): PricePrediction {
  return {
    ton: p50Ton,
    p10Ton: Math.max(0, p50Ton / 2),
    p50Ton,
    p90Ton,
    confidence: "medium",
    confidenceScore: 0.6,
    confidenceDefinition: "heuristic-score",
    oodScore: 0,
    featureDistance: 0,
    modelDisagreementLog: 0,
    trainedAt: "2026-07-31T00:00:00.000Z",
    modelP50Ton: p50Ton / 2,
    releaseGatePassed: true,
    outOfDistribution: false,
    releaseGateReason: "passed",
    splitStrategy: "temporal-group",
    dataCurrent: true,
    usd: null,
    rub: null,
    p10Usd: null,
    p90Usd: null,
    p10Rub: null,
    p90Rub: null,
  };
}

test("price filter uses one full prediction per candidate, refills, sorts by P50, and keeps only final estimates", async () => {
  const rejected = prediction(40, 90);
  const firstQualified = prediction(120, 180);
  // This fixture represents a name whose structural model would be low but
  // whose full comparable-aware prediction clears the threshold. The filter
  // must never run an earlier model-only rejection step.
  const comparableBoosted = prediction(250, 400);
  const predictions = new Map<string, PricePrediction>([
    ["below_threshold", rejected],
    ["first_qualified", firstQualified],
    ["comparable_boosted", comparableBoosted],
  ]);
  const predictionCalls: string[] = [];
  const dependencies: PriceFilterDependencies = {
    predict: async (username) => {
      predictionCalls.push(username);
      const result = predictions.get(username);
      if (!result) throw new Error(`unexpected username ${username}`);
      return result;
    },
  };
  const batches: GeneratedCandidate[][] = [
    [candidate("below_threshold"), candidate("first_qualified")],
    [candidate("first_qualified"), candidate("comparable_boosted")],
  ];
  let generationCalls = 0;

  const result = await collectPriceQualifiedCandidates(
    2,
    100,
    () => batches[generationCalls++] ?? [],
    { hardCapMultiplier: 10, hardCapMax: 100, maxAttempts: 5 },
    dependencies,
  );

  assert.equal(generationCalls, 2, "a rejected full estimate must trigger a refill batch");
  assert.deepEqual(predictionCalls, [
    "below_threshold",
    "first_qualified",
    "comparable_boosted",
  ]);
  assert.equal(result.checked, 3);
  assert.deepEqual(
    result.qualified.map((entry) => entry.username),
    ["comparable_boosted", "first_qualified"],
    "final candidates are ranked by the full P50, not discovery order",
  );
  assert.deepEqual([...result.estimates.keys()].sort(), [
    "comparable_boosted",
    "first_qualified",
  ]);
  assert.equal(result.estimates.has("below_threshold"), false);
  assert.equal(result.estimates.get("comparable_boosted"), comparableBoosted);
  assert.equal(result.estimates.get("first_qualified"), firstQualified);
});

test("price filter bounds failed predictions and stops when the generator is exhausted", async () => {
  const errors: string[] = [];
  const result = await collectPriceQualifiedCandidates(
    2,
    100,
    (() => {
      let call = 0;
      return () =>
        call++ === 0
          ? [candidate("prediction_error"), candidate("only_match")]
          : [];
    })(),
    { hardCapMultiplier: 2, hardCapMax: 4, maxAttempts: 4 },
    {
      predict: async (username) => {
        if (username === "prediction_error") throw new Error("fixture failure");
        return prediction(150, 220);
      },
      onPredictionError: (username, error) => {
        errors.push(`${username}:${error instanceof Error ? error.message : error}`);
      },
    },
  );

  assert.equal(result.checked, 2);
  assert.deepEqual(result.qualified.map((entry) => entry.username), ["only_match"]);
  assert.deepEqual([...result.estimates.keys()], ["only_match"]);
  assert.deepEqual(errors, ["prediction_error:fixture failure"]);
});

test("price filter never evaluates or returns a duplicate from one generator batch", async () => {
  const calls: string[] = [];
  const result = await collectPriceQualifiedCandidates(
    2,
    100,
    (() => {
      let call = 0;
      return () =>
        call++ === 0
          ? [candidate("same_name"), candidate("same_name"), candidate("second_name")]
          : [];
    })(),
    {},
    {
      predict: async (username) => {
        calls.push(username);
        return prediction(150, 220);
      },
    },
  );

  assert.deepEqual(calls, ["same_name", "second_name"]);
  assert.deepEqual(
    result.qualified.map((entry) => entry.username).sort(),
    ["same_name", "second_name"],
  );
  assert.equal(result.checked, 2);
});
