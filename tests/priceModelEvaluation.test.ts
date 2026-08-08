import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePriceIntervals,
  evaluatePricePredictions,
  evaluateTopTailRecall,
  priceFromLog,
  quantile,
} from "../src/priceModel/evaluation.js";

test("quantile interpolates deterministically", () => {
  assert.equal(quantile([4, 1, 3, 2], 0), 1);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([4, 1, 3, 2], 1), 4);
});

test("price metrics expose multiplicative accuracy and ranking", () => {
  const metrics = evaluatePricePredictions([10, 100, 1_000], [10, 200, 500]);
  assert.equal(metrics.count, 3);
  assert.ok(metrics.rmsle > 0);
  assert.ok(metrics.medianFactorError > 1.9 && metrics.medianFactorError < 2);
  assert.equal(metrics.within2x, 1);
  assert.equal(metrics.within3x, 1);
  assert.equal(metrics.spearman, 1);
});

test("factor accuracy uses true price ratios even for sub-10 TON sales", () => {
  const metrics = evaluatePricePredictions([1, 1], [3, 2]);
  assert.equal(metrics.within2x, 0.5);
  assert.equal(metrics.within3x, 1);
  assert.ok(Math.abs(metrics.medianFactorError - 2.5) < 1e-12);
});

test("interval metrics measure empirical coverage", () => {
  const metrics = evaluatePriceIntervals([10, 100], [5, 110], [20, 150]);
  assert.equal(metrics.coverage, 0.5);
  assert.ok(metrics.meanWidthLog > 0);
});

test("top-tail recall measures valuable-candidate discovery", () => {
  const metrics = evaluateTopTailRecall([1, 2, 3, 100], [1, 3, 2, 90], 0.25);
  assert.equal(metrics.selected, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(evaluateTopTailRecall([1, 2, 3, 100], [100, 3, 2, 1], 0.25).recall, 0);
});

test("top-tail recall gives cutoff ties fractional credit independent of row order", () => {
  const original = evaluateTopTailRecall(
    [100, 90, 1, 0],
    [10, 10, 10, 0],
    0.25,
  );
  const permuted = evaluateTopTailRecall(
    [1, 100, 0, 90],
    [10, 10, 0, 10],
    0.25,
  );

  assert.equal(original.selected, 1);
  assert.ok(Math.abs(original.recall - 1 / 3) < 1e-12);
  assert.equal(permuted.recall, original.recall);
});

test("top-tail recall treats ground-truth cutoff ties symmetrically", () => {
  const metrics = evaluateTopTailRecall([100, 100, 1, 0], [10, 9, 8, 7], 0.25);
  assert.equal(metrics.selected, 1);
  assert.equal(metrics.recall, 0.5);
});

test("log conversion is finite and non-negative", () => {
  assert.equal(priceFromLog(Number.NaN), 0);
  assert.equal(priceFromLog(-100), 0);
  assert.ok(Number.isFinite(priceFromLog(10_000)));
});
