import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MLP } from "../src/ml/mlp.js";
import {
  inspectPriceModel,
  predictPriceTon,
  priceModelApproved,
  priceModelExists,
} from "../src/priceModel/predict.js";
import { extractFeatures, FEATURE_NAMES } from "../src/priceModel/features.js";
import { PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE } from "../src/priceModel/policy.js";
import {
  fitPriceModel,
  PRICE_MODEL_SCHEMA_VERSION,
  type PriceModelFile,
} from "../src/priceModel/train.js";
import {
  buildSoldEventId,
  type SoldRecord,
} from "../src/priceData/soldHistory.js";

let cachedArtifact: PriceModelFile | undefined;

function statusHistory(): SoldRecord[] {
  return Array.from({ length: 40 }, (_, index) => {
    const record: SoldRecord = {
      username: `${String.fromCharCode(97 + (index % 26))}status${index}`,
      priceTon: 10 + index * index,
      saleAt: new Date(Date.UTC(2026, 5, index + 1)).toISOString(),
      scrapedAt: "2026-07-31T00:00:00.000Z",
    };
    return { ...record, eventId: buildSoldEventId(record) };
  });
}

function validArtifact(): PriceModelFile {
  if (!cachedArtifact) {
    cachedArtifact = fitPriceModel(statusHistory(), {
      epochs: 1,
      earlyStoppingRounds: 1,
      ensembleSize: 1,
      hiddenSizes: [3],
      gbtTrees: 1,
      gbtMaxDepth: 1,
      splitStrategy: "random",
    });
  }
  return JSON.parse(JSON.stringify(cachedArtifact)) as PriceModelFile;
}

test("price-model status requires a current, deeply valid and loadable artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-price-status-"));
  const path = join(directory, "price-mlp.json");
  try {
    assert.deepEqual(inspectPriceModel(path), {
      exists: false,
      valid: false,
      reason: "file not found",
    });

    const legacy = validArtifact() as Partial<PriceModelFile>;
    delete legacy.schemaVersion;
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    const legacyStatus = inspectPriceModel(path);
    assert.equal(legacyStatus.exists, true);
    assert.equal(legacyStatus.valid, false);
    assert.match(legacyStatus.reason ?? "", /legacy.*incompatible|retrain/i);
    assert.equal(priceModelExists(path), false);

    const corrupted = validArtifact() as unknown as {
      mlp: ReturnType<MLP["toJSON"]>;
    } & Record<string, unknown>;
    corrupted.mlp.layers[0].W[0].pop();
    writeFileSync(path, JSON.stringify(corrupted), "utf8");
    const corruptedStatus = inspectPriceModel(path);
    assert.equal(corruptedStatus.exists, true);
    assert.equal(corruptedStatus.valid, false);
    assert.match(corruptedStatus.reason ?? "", /invalid weights/i);
    assert.equal(priceModelExists(path), false);

    const valid = validArtifact();
    assert.equal(
      valid.releaseGate.minimumTestSize,
      PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE,
    );
    writeFileSync(path, JSON.stringify(valid), "utf8");
    const ready = inspectPriceModel(path);
    assert.equal(ready.exists, true);
    assert.equal(ready.valid, true);
    assert.equal(ready.schemaVersion, PRICE_MODEL_SCHEMA_VERSION);
    assert.equal(ready.trainedOn, 40);
    assert.equal(priceModelExists(path), true);
    assert.equal(priceModelApproved(path), false);
    assert.equal(ready.approved, false);
    assert.equal(ready.confidenceCalibrated, false);

    const confidenceSample = valid.metrics.confidenceCalibrationSize ?? 0;
    assert.ok(confidenceSample > 0);
    const testMetrics = {
      ...valid.metrics.test!,
      count: PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE,
    };
    const baselineRmsle = Math.max(testMetrics.rmsle * 2, testMetrics.rmsle + 0.1);
    const approvedBaseline = { ...testMetrics, rmsle: baselineRmsle };
    const approvedImprovement =
      (baselineRmsle - testMetrics.rmsle) / baselineRmsle;
    const approved: PriceModelFile = {
      ...valid,
      metrics: {
        ...valid.metrics,
        testSize: PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE,
        test: testMetrics,
        testModelOnly: {
          ...valid.metrics.testModelOnly!,
          count: PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE,
        },
        testInterval: {
          ...valid.metrics.testInterval!,
          count: PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE,
        },
        baselines: {
          globalMedian: { ...approvedBaseline },
          structuralMedian: { ...approvedBaseline },
          comparables: { ...approvedBaseline },
        },
      },
      confidenceCalibration: {
        definition: "within-2x",
        sampleSize: confidenceSample,
        bins: [
          {
            maxRawScore: 1,
            probabilityWithin2x: 0.7,
            sampleSize: confidenceSample,
          },
        ],
      },
      split: {
        strategy: "temporal-group",
        requestedStrategy: "temporal-group",
        groupKeyVersion: 2,
        exactEventTimeCoverage: 1,
        excludedForUnknownEventTime: 0,
        excludedForTemporalOrdering: 0,
        validationFraction: 0.15,
        stackerFraction: 0.1,
        calibrationFraction: 0.1,
        testFraction: 0.1,
        trainingThrough: "2026-06-01T00:00:00.000Z",
        validationThrough: "2026-06-02T00:00:00.000Z",
        stackerThrough: "2026-06-03T00:00:00.000Z",
        calibrationThrough: "2026-06-04T00:00:00.000Z",
        testThrough: "2026-06-05T00:00:00.000Z",
      },
      releaseGate: {
        passed: true,
        reason: "passed",
        minimumTestSize: PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE,
        bestBaseline: "globalMedian",
        rmsleImprovement: approvedImprovement,
      },
      capabilities: {
        intervalCalibrated: true,
        confidenceCalibrated: true,
        temporalEvaluation: true,
        approved: true,
      },
    };
    writeFileSync(path, JSON.stringify(approved), "utf8");
    const approvedStatus = inspectPriceModel(path);
    assert.equal(approvedStatus.valid, true);
    assert.equal(approvedStatus.approved, true);
    assert.equal(approvedStatus.confidenceCalibrated, true);
    assert.equal(priceModelApproved(path), true);

    const loweredGatePolicy = JSON.parse(JSON.stringify(approved)) as PriceModelFile;
    loweredGatePolicy.releaseGate.minimumTestSize =
      PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE - 1;
    writeFileSync(path, JSON.stringify(loweredGatePolicy), "utf8");
    const loweredGateStatus = inspectPriceModel(path);
    assert.equal(loweredGateStatus.valid, false);
    assert.match(loweredGateStatus.reason ?? "", /release-gate metadata is invalid/i);

    const inconsistentGate = JSON.parse(JSON.stringify(approved)) as PriceModelFile;
    inconsistentGate.releaseGate.passed = false;
    writeFileSync(path, JSON.stringify(inconsistentGate), "utf8");
    assert.equal(inspectPriceModel(path).valid, false);

    const inconsistentCohorts = JSON.parse(JSON.stringify(valid)) as PriceModelFile;
    inconsistentCohorts.metrics.residualCalibrationSize =
      (inconsistentCohorts.metrics.residualCalibrationSize ?? 0) + 1;
    writeFileSync(path, JSON.stringify(inconsistentCohorts), "utf8");
    assert.equal(inspectPriceModel(path).valid, false);

    const contradictoryReason = JSON.parse(JSON.stringify(valid)) as PriceModelFile;
    contradictoryReason.releaseGate.reason = "insufficient-test-data";
    writeFileSync(path, JSON.stringify(contradictoryReason), "utf8");
    assert.equal(inspectPriceModel(path).valid, false);

    const contradictoryTimeline = JSON.parse(JSON.stringify(valid)) as PriceModelFile;
    contradictoryTimeline.trainedThrough = "2020-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(contradictoryTimeline), "utf8");
    assert.equal(inspectPriceModel(path).valid, false);

    for (const requiredField of [
      "trainedThrough",
      "ensemble",
      "ridge",
      "gbt",
      "stacker",
      "calibration",
      "oodCalibration",
      "comparableBlendScale",
      "comparablePipelineVersion",
      "comparablePipelineHash",
      "dataHash",
      "split",
      "releaseGate",
      "capabilities",
      "metrics",
    ] as const) {
      const incomplete = validArtifact() as unknown as Record<string, unknown>;
      delete incomplete[requiredField];
      writeFileSync(path, JSON.stringify(incomplete), "utf8");
      assert.equal(inspectPriceModel(path).valid, false, requiredField);
    }

    // The readiness probe and real feature extractor agree on input width.
    assert.equal(extractFeatures("market").length, FEATURE_NAMES.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("historical inference rejects invalid or pre-training-cutoff valuationAt", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-price-cutoff-"));
  const modelDirectory = join(directory, "models");
  const dataDirectory = join(directory, "data");
  const originalDirectory = process.cwd();
  mkdirSync(modelDirectory);
  mkdirSync(dataDirectory);
  const baseArtifact = validArtifact();
  const confidenceSample = baseArtifact.metrics.confidenceCalibrationSize ?? 0;
  assert.ok(confidenceSample > 0);
  const artifact = {
    ...baseArtifact,
    trainedThrough: "2026-07-30T00:00:00.000Z",
    confidenceCalibration: {
      definition: "within-2x" as const,
      sampleSize: confidenceSample,
      bins: [
        {
          maxRawScore: 1,
          probabilityWithin2x: 0.8,
          sampleSize: confidenceSample,
        },
      ],
    },
    capabilities: {
      ...baseArtifact.capabilities,
      confidenceCalibrated: true,
    },
  };
  writeFileSync(
    join(modelDirectory, "price-mlp.json"),
    JSON.stringify(artifact),
    "utf8",
  );
  const historyPath = join(dataDirectory, "sold-history.json");
  writeFileSync(historyPath, JSON.stringify(statusHistory()), "utf8");

  try {
    process.chdir(directory);
    assert.throws(
      () =>
        predictPriceTon("market", {
          includeComparables: false,
          valuationAt: "not-a-date",
        }),
      /valuationAt must be a valid date or Unix millisecond timestamp/,
    );
    assert.throws(
      () =>
        predictPriceTon("market", {
          includeComparables: false,
          valuationAt: "2026-07-29T23:59:59.999Z",
        }),
      /leak future training data.*cutoff\/walk-forward artifact/i,
    );

    assert.throws(
      () =>
        predictPriceTon("market", {
          includeComparables: false,
          valuationAt: "2026-07-30T00:00:00.000Z",
        }),
      /not strictly after.*leak future training data/is,
    );

    const prediction = predictPriceTon("market", {
      includeComparables: false,
      valuationAt: "2026-07-30T00:00:00.001Z",
    });
    assert.equal(prediction.trainedThrough, artifact.trainedThrough);
    assert.equal(prediction.dataCurrent, true);
    assert.equal(prediction.splitStrategy, "random");
    assert.equal(prediction.releaseGateReason, "non-temporal-evaluation");
    assert.equal(typeof prediction.outOfDistribution, "boolean");
    assert.equal(prediction.confidenceDefinition, "probability-within-2x");
    // A failed release gate is reported separately and must not distort the
    // empirical calibration probability.
    assert.equal(prediction.confidenceScore, 0.8);

    writeFileSync(
      historyPath,
      JSON.stringify([
        ...statusHistory(),
        {
          username: "newmarketrow",
          priceTon: 999,
          saleAt: "2026-08-01T00:00:00.000Z",
          scrapedAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
      "utf8",
    );
    const future = new Date(Date.now() + 10_000);
    utimesSync(historyPath, future, future);
    const stale = inspectPriceModel();
    assert.equal(stale.valid, true);
    assert.equal(stale.dataCurrent, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.approved, false);
    assert.throws(
      () => predictPriceTon("market", { includeComparables: false }),
      /model is stale.*retrain/i,
    );
  } finally {
    process.chdir(originalDirectory);
    rmSync(directory, { recursive: true, force: true });
  }
});
