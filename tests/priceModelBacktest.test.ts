import assert from "node:assert/strict";
import test from "node:test";
import type { SoldRecord } from "../src/priceData/soldHistory.js";
import {
  backtestPriceModel,
  deterministicPriceBacktestSeeds,
} from "../src/priceModel/backtest.js";

function fixture(count = 12): SoldRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    username: `${String.fromCharCode(97 + index)}name`,
    priceTon: index % 4 === 0 ? 1_000 + index * 10 : 10 + index * index,
    saleAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    scrapedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
    confidence: "high",
    provenance: { parser: "fragment-sold-table" },
  }));
}

test("repeated-seed backtest retains each run and computes exact summaries", () => {
  const result = backtestPriceModel(fixture(), {
    seeds: [17, 31],
    training: {
      epochs: 1,
      earlyStoppingRounds: 1,
      hiddenSizes: [2],
      batchSize: 4,
      ensembleSize: 1,
      gbtTrees: 1,
      gbtMaxDepth: 1,
      valFraction: 0.2,
      stackerFraction: 0.1,
      calibrationFraction: 0.1,
      testFraction: 0.2,
      splitStrategy: "random",
    },
  });

  assert.equal(result.runCount, 2);
  assert.deepEqual(result.seeds, [17, 31]);
  assert.deepEqual(result.runs.map((run) => run.seed), result.seeds);
  assert.ok(result.runs.every((run) => run.split.strategy === "random"));
  assert.ok(result.runs.every((run) => run.split.stackerFraction === 0.1));
  assert.ok(result.runs.every((run) => run.metrics.test?.count === 2));
  assert.ok(result.runs.every((run) => run.metrics.testTopTail));
  assert.ok(result.runs.every((run) => run.metrics.testInterval));

  const rmsle = result.runs.map((run) => run.metrics.test!.rmsle);
  const rmsleMean = (rmsle[0] + rmsle[1]) / 2;
  assert.equal(result.summary.testRmsle.mean, rmsleMean);
  assert.equal(result.summary.testRmsle.min, Math.min(...rmsle));
  assert.equal(result.summary.testRmsle.max, Math.max(...rmsle));
  assert.equal(
    result.summary.testRmsle.std,
    Math.sqrt(rmsle.reduce((sum, value) => sum + (value - rmsleMean) ** 2, 0) / 2),
  );
  assert.equal(
    result.summary.releaseGatePass.mean,
    result.runs.filter((run) => run.releaseGate.passed).length / result.runCount,
  );
  for (const summary of Object.values(result.summary)) {
    assert.ok(Number.isFinite(summary.mean));
    assert.ok(Number.isFinite(summary.std));
    assert.ok(summary.min <= summary.mean && summary.mean <= summary.max);
  }
});

test("seed generation is deterministic and options are rejected before fitting", () => {
  assert.deepEqual(
    deterministicPriceBacktestSeeds(3, 123),
    deterministicPriceBacktestSeeds(3, 123),
  );
  assert.equal(new Set(deterministicPriceBacktestSeeds(100, 0)).size, 100);

  const history = fixture();
  assert.throws(
    () => backtestPriceModel(history, { seeds: [1, 1] }),
    /unique/,
  );
  assert.throws(
    () => backtestPriceModel(history, { seeds: [1], runs: 1 }),
    /mutually exclusive/,
  );
  assert.throws(
    () => backtestPriceModel(history, { runs: 0 }),
    /runs must be an integer/,
  );
  assert.throws(
    () =>
      backtestPriceModel(history, {
        seeds: [1],
        training: { epochs: 1, earlyStoppingRounds: 2 },
      }),
    /earlyStoppingRounds/,
  );
  assert.throws(
    () =>
      backtestPriceModel(history, {
        seeds: [1],
        training: { valFraction: 0.5, calibrationFraction: 0.2, testFraction: 0.2 },
      }),
    /holdout fractions/,
  );
  assert.throws(
    () =>
      backtestPriceModel(history, {
        seeds: [1],
        training: {
          valFraction: 0.3,
          stackerFraction: 0.2,
          calibrationFraction: 0.2,
          testFraction: 0.11,
        },
      }),
    /holdout fractions/,
  );
  assert.throws(
    () => backtestPriceModel(history, { seeds: [1], training: { testFraction: 0 } }),
    /testFraction must be greater than 0/,
  );
  assert.throws(
    () =>
      backtestPriceModel(history, {
        seeds: [1],
        training: { seed: 5 } as never,
      }),
    /unknown option.*seed/,
  );
  assert.throws(
    () => backtestPriceModel(history, { seeds: [1], surprise: true } as never),
    /unknown option.*surprise/,
  );
});
