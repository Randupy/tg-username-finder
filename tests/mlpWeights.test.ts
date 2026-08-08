import assert from "node:assert/strict";
import test from "node:test";
import { MLP } from "../src/ml/mlp.js";

function makeRegressor(): MLP {
  return new MLP({
    inputSize: 1,
    hiddenSizes: [],
    outputSize: 1,
    outputActivation: "linear",
    seed: 17,
  });
}

test("MLP sample weights change the fitted regression target", () => {
  const inputs = [[1], [1]];
  const targets = [[0], [10]];
  const unweighted = makeRegressor();
  const weighted = makeRegressor();

  unweighted.train(inputs, targets, {
    epochs: 300,
    batchSize: 2,
    learningRate: 0.03,
  });
  weighted.train(inputs, targets, {
    epochs: 300,
    batchSize: 2,
    learningRate: 0.03,
    sampleWeights: [20, 1],
  });

  assert.ok(weighted.predict([1])[0] < unweighted.predict([1])[0]);
  assert.throws(
    () =>
      weighted.train(inputs, targets, {
        epochs: 1,
        sampleWeights: [1],
      }),
    /sampleWeights/,
  );
});
