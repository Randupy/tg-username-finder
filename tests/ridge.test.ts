import assert from "node:assert/strict";
import test from "node:test";
import { RidgeModel } from "../src/ml/ridge.js";

test("ridge fits and serializes a deterministic linear relationship", () => {
  const inputs = Array.from({ length: 40 }, (_, index) => [index / 10, index % 3]);
  const targets = inputs.map(([left, right]) => 2 * left - 0.5 * right + 3);
  const first = RidgeModel.fit(inputs, targets, { lambda: 0.01, robustIterations: 0 });
  const second = RidgeModel.fit(inputs, targets, { lambda: 0.01, robustIterations: 0 });
  assert.deepEqual(first.toJSON(), second.toJSON());
  const restored = RidgeModel.fromJSON(first.toJSON());
  assert.ok(Math.abs(restored.predict([1.5, 2])[0] - 5) < 0.02);
});

test("robust ridge reduces the influence of an extreme target", () => {
  const inputs = Array.from({ length: 30 }, (_, index) => [index]);
  const cleanTargets = inputs.map(([value]) => value * 2 + 1);
  const contaminated = [...cleanTargets];
  contaminated[15] = 100_000;
  const ordinary = RidgeModel.fit(inputs, contaminated, {
    lambda: 0.1,
    robustIterations: 0,
  });
  const robust = RidgeModel.fit(inputs, contaminated, {
    lambda: 0.1,
    robustIterations: 3,
  });
  const expected = 21;
  assert.ok(
    Math.abs(robust.predict([10])[0] - expected) <
      Math.abs(ordinary.predict([10])[0] - expected),
  );
});

test("ridge quality weights reduce the influence of a low-quality outlier", () => {
  const inputs = [[0], [1], [2], [3]];
  const targets = [0, 1, 2, 30];
  const unweighted = RidgeModel.fit(inputs, targets, {
    lambda: 0.01,
    robustIterations: 0,
  });
  const weighted = RidgeModel.fit(inputs, targets, {
    lambda: 0.01,
    robustIterations: 0,
    sampleWeights: [1, 1, 1, 0.01],
  });

  assert.ok(
    Math.abs(weighted.predict([2])[0] - 2) <
      Math.abs(unweighted.predict([2])[0] - 2),
  );
  assert.throws(
    () =>
      RidgeModel.fit(inputs, targets, {
        sampleWeights: [1, 1],
      }),
    /sampleWeights/,
  );
});
