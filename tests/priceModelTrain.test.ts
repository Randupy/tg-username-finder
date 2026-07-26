import assert from "node:assert/strict";
import test from "node:test";
import { MLP } from "../src/ml/mlp.js";
import { extractFeatures } from "../src/priceModel/features.js";
import {
  deterministicShuffle,
  fitPriceModel,
  preparePriceTrainingData,
} from "../src/priceModel/train.js";
import type { SoldRecord } from "../src/priceData/soldHistory.js";

function records(count = 24): SoldRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    username: `name${String(index).padStart(2, "0")}`,
    priceTon: (index + 1) ** 2 + (index % 3) * 7,
    scrapedAt: new Date(2025, 0, index + 1).toISOString(),
  }));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function modelMse(mlp: MLP, inputs: number[][], targets: number[][]): number {
  return average(
    inputs.map((input, index) => {
      const delta = mlp.predict(input)[0] - targets[index][0];
      return delta * delta;
    }),
  );
}

test("shuffle and split are deterministic and do not mutate source data", () => {
  const source = records();
  const originalOrder = source.map((record) => record.username);

  const first = deterministicShuffle(source, 123).map((record) => record.username);
  const second = deterministicShuffle(source, 123).map((record) => record.username);

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, originalOrder);
  assert.deepEqual(source.map((record) => record.username), originalOrder);
});

test("normalization statistics are calculated from the training partition only", () => {
  const prepared = preparePriceTrainingData(records(), 0.25, 987);
  const rawTrainingFeatures = prepared.trainingRecords.map((record) =>
    extractFeatures(record.username),
  );

  for (let feature = 0; feature < prepared.featureMean.length; feature++) {
    const expected = average(rawTrainingFeatures.map((row) => row[feature]));
    assert.ok(Math.abs(prepared.featureMean[feature] - expected) < 1e-12);
  }
  const expectedTargetMean = average(
    prepared.trainingRecords.map((record) => Math.log(record.priceTon + 1)),
  );
  assert.ok(Math.abs(prepared.targetMean - expectedTargetMean) < 1e-12);

  // A normalized training column/target is centered around zero; validation
  // data is deliberately absent from the statistic.
  for (let feature = 0; feature < prepared.featureMean.length; feature++) {
    assert.ok(Math.abs(average(prepared.trainInputs.map((row) => row[feature]))) < 1e-10);
  }
  assert.ok(Math.abs(average(prepared.trainTargets.map(([target]) => target))) < 1e-10);
});

test("saved checkpoint and metrics describe the same best validation model", () => {
  const history = records();
  const options = {
    epochs: 30,
    hiddenSizes: [6],
    valFraction: 0.25,
    seed: 456,
    batchSize: 6,
    learningRate: 0.03,
  };
  const file = fitPriceModel(history, options);
  const repeated = fitPriceModel(history, options);
  const prepared = preparePriceTrainingData(history, options.valFraction, options.seed);
  const mlp = MLP.fromJSON(file.mlp);

  assert.deepEqual(file.mlp, repeated.mlp);
  assert.deepEqual(file.metrics, repeated.metrics);
  assert.ok(file.metrics);
  assert.equal(file.metrics.trainingSize, prepared.trainingRecords.length);
  assert.equal(file.metrics.validationSize, prepared.validationRecords.length);
  assert.ok(file.metrics.bestEpoch >= 0 && file.metrics.bestEpoch < options.epochs);
  assert.ok(file.metrics.bestEpoch < options.epochs - 1, "the persisted checkpoint must not be final weights");
  assert.ok(
    Math.abs(
      file.metrics.validationMse -
        modelMse(mlp, prepared.validationInputs, prepared.validationTargets),
    ) < 1e-12,
  );
  assert.ok(
    Math.abs(file.metrics.trainMse - modelMse(mlp, prepared.trainInputs, prepared.trainTargets)) <
      1e-12,
  );
});
