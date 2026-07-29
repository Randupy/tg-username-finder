import assert from "node:assert/strict";
import test from "node:test";
import {
  priceWeightedUsernames,
  weightForPricePercentile,
} from "../src/generatorModel/train.js";
import type { SoldRecord } from "../src/priceData/soldHistory.js";

function record(username: string, priceTon: number): SoldRecord {
  return { username, priceTon, scrapedAt: new Date(2025, 0, 1).toISOString() };
}

test("weightForPricePercentile drops the bottom quartile and favors the top", () => {
  assert.equal(weightForPricePercentile(0), 0);
  assert.equal(weightForPricePercentile(0.24), 0);
  assert.equal(weightForPricePercentile(0.25), 1);
  assert.equal(weightForPricePercentile(0.49), 1);
  assert.equal(weightForPricePercentile(0.5), 2);
  assert.equal(weightForPricePercentile(0.74), 2);
  assert.equal(weightForPricePercentile(0.75), 4);
  assert.equal(weightForPricePercentile(1), 4);
});

test("priceWeightedUsernames repeats expensive names and drops floor-price noise", () => {
  // 20 records, evenly spaced prices 1..20: bottom 5 are the noisy floor,
  // next 5 get a single pass, next 5 double, top 5 quadruple.
  const sold = Array.from({ length: 20 }, (_, i) => record(`name${i}`, i + 1));
  const weighted = priceWeightedUsernames(sold);

  const countOf = (username: string): number =>
    weighted.filter((u) => u === username).length;

  assert.equal(countOf("name0"), 0); // cheapest -- bottom quartile, dropped
  assert.equal(countOf("name4"), 0);
  assert.equal(countOf("name5"), 1); // second quartile
  assert.equal(countOf("name9"), 1);
  assert.equal(countOf("name10"), 2); // third quartile
  assert.equal(countOf("name14"), 2);
  assert.equal(countOf("name15"), 4); // top quartile -- most repeated
  assert.equal(countOf("name19"), 4);
});

test("priceWeightedUsernames handles an empty history without throwing", () => {
  assert.deepEqual(priceWeightedUsernames([]), []);
});
