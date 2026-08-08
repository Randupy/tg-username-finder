import assert from "node:assert/strict";
import test from "node:test";
import { MLP } from "../src/ml/mlp.js";
import { extractFeatures } from "../src/priceModel/features.js";
import {
  deterministicShuffle,
  applyPriceConfidenceCalibration,
  buildConfidenceCalibration,
  buildResidualCalibration,
  fitPriceModel,
  preparePriceTrainingData,
  priceLexicalFamily,
  soldRecordExactEventTimestamp,
  soldRecordTrainingWeight,
  soldRecordTimestamp,
  splitIndependentCalibrationCohorts,
  rawPriceConfidenceScore,
  PRICE_MODEL_SCHEMA_VERSION,
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
  // Every `nameNN` row belongs to one lexical family, so a group-safe holdout
  // is impossible; the fallback is explicitly random and therefore unapproved.
  assert.equal(prepared.split.strategy, "random");
  assert.equal(prepared.split.exactEventTimeCoverage, 0);
  assert.equal(prepared.trainWeights.length, prepared.trainingRecords.length);
});

test("default split is temporal and keeps lexical families in one partition", () => {
  const history: SoldRecord[] = [];
  for (let family = 0; family < 12; family++) {
    const letter = String.fromCharCode(97 + family);
    for (let variant = 0; variant < 2; variant++) {
      history.push({
        username: `fam${letter}${variant}`,
        priceTon: 10 + family * 10 + variant,
        saleAt: new Date(Date.UTC(2025, 0, family * 2 + variant + 1)).toISOString(),
        scrapedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
      });
    }
  }
  const prepared = preparePriceTrainingData(history, 0.15, 123);
  const partitions = [
    prepared.trainingRecords,
    prepared.validationRecords,
    prepared.stackerRecords,
    prepared.calibrationRecords,
    prepared.testRecords,
  ];
  const owner = new Map<string, number>();
  partitions.forEach((partition, partitionIndex) => {
    for (const record of partition) {
      const family = priceLexicalFamily(record.username);
      assert.equal(owner.get(family) ?? partitionIndex, partitionIndex);
      owner.set(family, partitionIndex);
    }
  });
  assert.ok(prepared.testRecords.length > 0);
  assert.equal(prepared.split.strategy, "temporal-group");
  assert.ok(prepared.testRecords.every((record) => soldRecordExactEventTimestamp(record)));
  assert.ok(
    Math.min(...prepared.testRecords.map(soldRecordTimestamp)) >=
      Math.max(...prepared.trainingRecords.map(soldRecordTimestamp)),
  );
});

test("temporal grouped split drops cross-boundary resales and stays strictly ordered", () => {
  const origin = Date.UTC(2025, 0, 1);
  const day = (offset: number): string =>
    new Date(origin + offset * 86_400_000).toISOString();
  const history: SoldRecord[] = [];
  for (let family = 0; family < 12; family++) {
    const letter = String.fromCharCode(97 + family);
    const firstDay = family * 10 + 1;
    const crossingDay =
      family === 0 ? 500 : family === 9 ? 180 : family === 10 ? 200 : firstDay + 1;
    history.push(
      {
        username: `fam${letter}0`,
        priceTon: 10 + family,
        saleAt: day(firstDay),
        scrapedAt: day(600),
      },
      {
        username: `fam${letter}1`,
        priceTon: 20 + family,
        saleAt: day(crossingDay),
        scrapedAt: day(600),
      },
    );
  }

  const prepared = preparePriceTrainingData(history, 0.15, 321);
  const cohorts = [
    prepared.trainingRecords,
    prepared.validationRecords,
    prepared.stackerRecords,
    prepared.calibrationRecords,
    prepared.testRecords,
  ];
  const range = (records: readonly SoldRecord[]): [number, number] => {
    const timestamps = records.map((record) => soldRecordExactEventTimestamp(record)!);
    return [Math.min(...timestamps), Math.max(...timestamps)];
  };

  assert.equal(prepared.split.strategy, "temporal-group");
  assert.ok(prepared.split.excludedForTemporalOrdering >= 3);
  for (let index = 0; index < cohorts.length - 1; index++) {
    const [, previousMax] = range(cohorts[index]);
    const [nextMin] = range(cohorts[index + 1]);
    assert.ok(previousMax < nextMin, `${previousMax} must precede ${nextMin}`);
  }

  const owner = new Map<string, number>();
  cohorts.forEach((cohort, cohortIndex) => {
    for (const record of cohort) {
      const family = priceLexicalFamily(record.username);
      assert.equal(owner.get(family) ?? cohortIndex, cohortIndex);
      owner.set(family, cohortIndex);
    }
  });
});

test("evidence quality produces bounded deterministic training weights", () => {
  const legacy: SoldRecord = {
    username: "legacy",
    priceTon: 10,
    scrapedAt: "2025-01-01T00:00:00.000Z",
  };
  const exact: SoldRecord = {
    ...legacy,
    saleAt: "2024-12-01T00:00:00.000Z",
    confidence: "high",
    provenance: { parser: "fragment-sold-table" },
  };
  const fallback: SoldRecord = {
    ...legacy,
    confidence: "low",
    provenance: { parser: "fragment-text" },
  };

  assert.equal(soldRecordTrainingWeight(exact), 1);
  assert.ok(soldRecordTrainingWeight(fallback) < soldRecordTrainingWeight(legacy));
  assert.ok(soldRecordTrainingWeight(fallback) >= 0.2);
});

test("MLP checkpoint and reported MSE honor evidence sample weights", () => {
  const history: SoldRecord[] = Array.from({ length: 40 }, (_, index) => ({
    username: `${String.fromCharCode(97 + (index % 26))}weighted${index}`,
    priceTon: 5 + index ** 2,
    saleAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    scrapedAt: "2025-03-01T00:00:00.000Z",
    confidence: index % 3 === 0 ? "high" : "low",
    provenance: {
      parser: index % 3 === 0 ? "fragment-sold-table" : "fragment-text",
    },
  }));
  const options = {
    epochs: 1,
    earlyStoppingRounds: 1,
    ensembleSize: 1,
    hiddenSizes: [3],
    gbtTrees: 1,
    gbtMaxDepth: 1,
    splitStrategy: "random" as const,
    seed: 876,
  };
  const prepared = preparePriceTrainingData(history, 0.15, options.seed, options);
  const file = fitPriceModel(history, options);
  const mlp = MLP.fromJSON(file.mlp);
  const weightedMse = (
    inputs: number[][],
    targets: number[][],
    rows: SoldRecord[],
  ): number => {
    const weights = rows.map(soldRecordTrainingWeight);
    return inputs.reduce((sum, input, index) => {
      const delta = mlp.predict(input)[0] - targets[index][0];
      return sum + weights[index] * delta * delta;
    }, 0) / weights.reduce((sum, value) => sum + value, 0);
  };

  assert.ok(
    Math.abs(
      file.metrics.trainMse -
        weightedMse(prepared.trainInputs, prepared.trainTargets, prepared.trainingRecords),
    ) < 1e-12,
  );
  assert.ok(
    Math.abs(
      file.metrics.validationMse -
        weightedMse(
          prepared.validationInputs,
          prepared.validationTargets,
          prepared.validationRecords,
        ),
    ) < 1e-12,
  );
});

test("confidence score can be mapped to an empirical within-2x probability", () => {
  const raw = rawPriceConfidenceScore(0, 0, 200);
  assert.equal(raw, 1);
  assert.equal(
    applyPriceConfidenceCalibration(
      {
        definition: "within-2x",
        sampleSize: 100,
        bins: [
          { maxRawScore: 0.5, probabilityWithin2x: 0.4, sampleSize: 50 },
          { maxRawScore: 1, probabilityWithin2x: 0.8, sampleSize: 50 },
        ],
      },
      raw,
    ),
    0.8,
  );
});

test("calibration never splits equal scores across duplicate thresholds", () => {
  const predictedLogs = [
    ...new Array(150).fill(Math.log1p(10)),
    ...new Array(50).fill(Math.log1p(100)),
  ];
  const actualLogs = predictedLogs.map((value, index) =>
    value + (index % 5 - 2) * 0.05,
  );
  const residual = buildResidualCalibration(predictedLogs, actualLogs);
  assert.deepEqual(residual.bins?.map((bin) => bin.sampleSize), [150, 50]);
  assert.ok(residual.bins![0].maxPredictedLog < residual.bins![1].maxPredictedLog);

  const allTied = buildResidualCalibration(
    new Array(400).fill(1),
    Array.from({ length: 400 }, (_, index) => 1 + (index % 7) * 0.01),
  );
  assert.equal(allTied.bins, undefined);

  const confidence = buildConfidenceCalibration(
    [...new Array(100).fill(0.2), ...new Array(100).fill(0.8)],
    [...new Array(100).fill(100), ...new Array(100).fill(10)],
    new Array(200).fill(10),
  );
  assert.deepEqual(confidence?.bins.map((bin) => bin.sampleSize), [100, 100]);
  assert.deepEqual(confidence?.bins.map((bin) => bin.maxRawScore), [0.2, 0.8]);
});

test("blend, residual and confidence calibration use disjoint grouped cohorts", () => {
  const calibrationRecords: SoldRecord[] = Array.from({ length: 12 }, (_, index) => ({
    username: `cal${String.fromCharCode(97 + index)}x`,
    priceTon: 10 + index,
    saleAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    scrapedAt: "2025-02-01T00:00:00.000Z",
  }));
  const subsets = splitIndependentCalibrationCohorts(
    calibrationRecords,
    "temporal-group",
    123,
  );
  const selection = new Set(subsets.blendSelectionIndexes);
  const residual = new Set(subsets.residualCalibrationIndexes);
  const confidence = new Set(subsets.confidenceCalibrationIndexes);
  assert.ok(selection.size > 0);
  assert.ok(residual.size > 0);
  assert.ok(confidence.size > 0);
  assert.ok([...selection].every((index) => !residual.has(index) && !confidence.has(index)));
  assert.ok([...residual].every((index) => !confidence.has(index)));
  assert.ok(
    Math.max(...[...selection].map((index) => soldRecordTimestamp(calibrationRecords[index]))) <
      Math.min(...[...residual].map((index) => soldRecordTimestamp(calibrationRecords[index]))),
  );
  assert.ok(
    Math.max(...[...residual].map((index) => soldRecordTimestamp(calibrationRecords[index]))) <
      Math.min(...[...confidence].map((index) => soldRecordTimestamp(calibrationRecords[index]))),
  );
  assert.throws(
    () =>
      preparePriceTrainingData(calibrationRecords, 0.15, 123, {
        calibrationFraction: 0,
      }),
    /calibrationFraction must be greater than 0/,
  );
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
  assert.equal(file.schemaVersion, PRICE_MODEL_SCHEMA_VERSION);
  assert.equal(file.ensemble?.length, 3);
  assert.equal(file.ridge?.weights.length, file.featureNames?.length);
  assert.equal(file.gbt?.featureCount, file.featureNames?.length);
  assert.equal(file.tailClassifiers?.length, 3);
  assert.equal(file.stacker?.weights.length, file.stackFeatureNames?.length);
  assert.ok(file.calibration && file.calibration.sampleSize > 0);
  assert.ok(file.releaseGate);
  assert.equal(file.split?.strategy, "random");
  assert.equal(file.releaseGate?.passed, false);
  assert.equal(file.releaseGate?.reason, "non-temporal-evaluation");
  assert.ok(file.metrics);
  assert.equal(file.metrics.trainingSize, prepared.trainingRecords.length);
  assert.equal(file.metrics.validationSize, prepared.validationRecords.length);
  assert.equal(file.metrics.stackerSize, prepared.stackerRecords.length);
  assert.equal(file.metrics.calibrationSize, prepared.calibrationRecords.length);
  assert.equal(
    (file.metrics.blendSelectionSize ?? 0) +
      (file.metrics.residualCalibrationSize ?? 0) +
      (file.metrics.confidenceCalibrationSize ?? 0) +
      (file.metrics.calibrationUnusedSize ?? 0),
    file.metrics.calibrationSize,
  );
  assert.equal(file.metrics.finalCalibrationSize, file.metrics.residualCalibrationSize);
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
