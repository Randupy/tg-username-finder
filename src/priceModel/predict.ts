import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { GradientBoostedTrees } from "../ml/gradientBoostedTrees.js";
import { MLP } from "../ml/mlp.js";
import { RidgeModel } from "../ml/ridge.js";
import {
  DEFAULT_MARKET_EVENTS_PATH,
  loadMarketEvents,
  type MarketEvent,
} from "../priceData/marketEvents.js";
import { loadSoldHistory } from "../priceData/store.js";
import { convertTon, getRates } from "../rates.js";
import {
  COMPARABLE_PIPELINE_VERSION,
  estimateProductionComparablePrice,
  type ComparableEstimate,
  type ComparableRow,
  type ComparableTimestamp,
} from "./comparables.js";
import { priceFromLog } from "./evaluation.js";
import { extractFeatures, FEATURE_NAMES } from "./features.js";
import { estimateLiquidity } from "./liquidity.js";
import {
  marketEventsToLiquidityListings,
  type LiquidityMarketBuildDiagnostics,
} from "./liquidityMarket.js";
import { PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE } from "./policy.js";
import {
  MODEL_PATH,
  PRICE_DISAGREEMENT_OOD_INTERVAL_FACTOR,
  PRICE_MODEL_SCHEMA_VERSION,
  PRICE_OOD_INTERVAL_LOG_WIDTH,
  applyPriceConfidenceCalibration,
  combinedRawPriceConfidence,
  comparableBlendWeight,
  comparablePipelineHash,
  priceHistoryDataHash,
  rawPriceConfidenceScore,
  selectPriceCalibrationBin,
  type PriceModelFile,
} from "./train.js";

export type PriceConfidence = "low" | "medium" | "high";

export interface PriceLiquidityPrediction {
  saleProbability30d: number;
  saleProbability90d: number;
  saleProbability365d: number;
  medianDaysToSale: number | null;
  expectedSalePriceTon: number | null;
  confidenceScore: number;
  outOfDistribution: boolean;
  oodReasons: string[];
  effectiveSampleSize: number;
  usedObservationCount: number;
  buildDiagnostics: LiquidityMarketBuildDiagnostics;
}

export interface PricePredictionTon {
  /** Calibrated median estimate; kept as `ton` for API compatibility. */
  ton: number;
  p10Ton: number;
  p50Ton: number;
  p90Ton: number;
  confidence: PriceConfidence;
  confidenceScore: number;
  /** Empirical probability only when the artifact has enough calibration data. */
  confidenceDefinition: "probability-within-2x" | "heuristic-score";
  oodScore: number;
  featureDistance: number;
  modelDisagreementLog: number;
  trainedAt: string;
  trainedThrough?: string;
  modelP50Ton: number;
  comparableP50Ton?: number;
  comparableEffectiveSampleSize?: number;
  topComparables?: ComparableRow[];
  liquidity?: PriceLiquidityPrediction;
  releaseGatePassed?: boolean;
  /** Explicit reliability signal; callers must not infer this from a score threshold. */
  outOfDistribution: boolean;
  releaseGateReason: NonNullable<PriceModelFile["releaseGate"]>["reason"];
  splitStrategy: NonNullable<PriceModelFile["split"]>["strategy"];
  /** True only when the default sold-history corpus matches the artifact hash. */
  dataCurrent: boolean;
}

export interface PricePrediction extends PricePredictionTon {
  usd: number | null;
  rub: number | null;
  p10Usd: number | null;
  p90Usd: number | null;
  p10Rub: number | null;
  p90Rub: number | null;
  rateFetchedAt?: string;
  ratesError?: string;
}

interface LoadedPriceModel {
  models: Array<MLP | RidgeModel>;
  gbt: GradientBoostedTrees;
  tailClassifiers: RidgeModel[];
  stacker: RidgeModel;
  file: PriceModelFile;
  mtimeMs: number;
  path: string;
  dataCurrent: boolean;
}

interface InstantiatedPriceModels {
  models: Array<MLP | RidgeModel>;
  gbt: GradientBoostedTrees;
  tailClassifiers: RidgeModel[];
  stacker: RidgeModel;
}

function artifactApproved(file: PriceModelFile): boolean {
  return file.capabilities.approved;
}

export interface PriceModelStatus {
  exists: boolean;
  valid: boolean;
  /** True only after a strict temporal benchmark and confidence calibration pass. */
  approved?: boolean;
  confidenceCalibrated?: boolean;
  releaseGateReason?: NonNullable<PriceModelFile["releaseGate"]>["reason"];
  splitStrategy?: NonNullable<PriceModelFile["split"]>["strategy"];
  dataCurrent?: boolean;
  stale?: boolean;
  reason?: string;
  trainedAt?: string;
  trainedOn?: number;
  schemaVersion?: number;
}

export interface PricePredictionOptions {
  /** Disable retrieval only for diagnostics/model ablations. Default: enabled. */
  includeComparables?: boolean;
  /**
   * Cutoff for comparable and liquidity evidence. This alone cannot make a
   * model trained on later data leakage-free: inference is rejected when the
   * artifact's `trainedThrough` is at or after this timestamp.
   */
  valuationAt?: ComparableTimestamp;
  excludeEventId?: string | number;
  /**
   * Estimate time-to-sale from listing lifecycles. It is automatically
   * disabled when comparables are disabled, unless explicitly enabled.
   */
  includeLiquidity?: boolean;
  /** Condition liquidity on a concrete ask instead of the predicted P50. */
  askingPriceTon?: number;
}

let cachedModel: LoadedPriceModel | null = null;
let cachedHistory: {
  records: ReturnType<typeof loadSoldHistory>;
  mtimeMs: number;
  path: string;
  dataHash: string;
} | null = null;
let cachedLiquidityHistory: {
  events: readonly MarketEvent[];
  observations: ReturnType<typeof marketEventsToLiquidityListings>;
  mtimeMs: number;
} | null = null;
const HISTORY_PATH = "data/sold-history.json";

function isFiniteArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function validAccuracyMetric(value: unknown, expectedCount: number): boolean {
  if (!value || typeof value !== "object") return false;
  const metric = value as Record<string, unknown>;
  return (
    metric.count === expectedCount &&
    ["rmsle", "meanAbsoluteLogError", "medianFactorError"].every(
      (key) => typeof metric[key] === "number" && Number.isFinite(metric[key]) && metric[key] >= 0,
    ) &&
    ["within2x", "within3x"].every(
      (key) =>
        typeof metric[key] === "number" &&
        Number.isFinite(metric[key]) &&
        metric[key] >= 0 &&
        metric[key] <= 1,
    ) &&
    typeof metric.spearman === "number" &&
    Number.isFinite(metric.spearman) &&
    metric.spearman >= -1 &&
    metric.spearman <= 1
  );
}

function validRankingMetric(value: unknown, expectedCount: number): boolean {
  if (!value || typeof value !== "object") return false;
  const metric = value as Record<string, unknown>;
  return (
    typeof metric.fraction === "number" &&
    Number.isFinite(metric.fraction) &&
    metric.fraction > 0 &&
    metric.fraction <= 1 &&
    Number.isSafeInteger(metric.selected) &&
    (metric.selected as number) > 0 &&
    (metric.selected as number) <= expectedCount &&
    typeof metric.recall === "number" &&
    Number.isFinite(metric.recall) &&
    metric.recall >= 0 &&
    metric.recall <= 1
  );
}

function validateNetwork(value: unknown, label: string): void {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} is not an object`);
  }
  const network = value as {
    config?: {
      inputSize?: unknown;
      hiddenSizes?: unknown;
      outputSize?: unknown;
      outputActivation?: unknown;
    };
    layers?: unknown;
  };
  const config = network.config;
  if (
    !config ||
    config.inputSize !== FEATURE_NAMES.length ||
    config.outputSize !== 1 ||
    config.outputActivation !== "linear" ||
    !Array.isArray(config.hiddenSizes) ||
    config.hiddenSizes.some(
      (size) => !Number.isSafeInteger(size) || (size as number) <= 0,
    )
  ) {
    throw new Error(`${label} has an incompatible config`);
  }

  const dimensions = [
    FEATURE_NAMES.length,
    ...(config.hiddenSizes as number[]),
    1,
  ];
  if (
    !Array.isArray(network.layers) ||
    network.layers.length !== dimensions.length - 1
  ) {
    throw new Error(`${label} has an incompatible layer count`);
  }
  for (let layerIndex = 0; layerIndex < network.layers.length; layerIndex++) {
    const layer = network.layers[layerIndex];
    if (!layer || typeof layer !== "object") {
      throw new Error(`${label} layer ${layerIndex} is not an object`);
    }
    const candidate = layer as { W?: unknown; b?: unknown };
    const inputSize = dimensions[layerIndex];
    const outputSize = dimensions[layerIndex + 1];
    if (
      !Array.isArray(candidate.W) ||
      candidate.W.length !== outputSize ||
      candidate.W.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== inputSize ||
          row.some((weight) => typeof weight !== "number" || !Number.isFinite(weight)),
      ) ||
      !isFiniteArray(candidate.b, outputSize)
    ) {
      throw new Error(`${label} layer ${layerIndex} has invalid weights`);
    }
  }
}

function validateModelFile(value: unknown): PriceModelFile {
  if (!value || typeof value !== "object") throw new Error("model artifact is not an object");
  const file = value as Partial<PriceModelFile>;
  if (file.schemaVersion !== PRICE_MODEL_SCHEMA_VERSION) {
    throw new Error(
      `model schema ${String(file.schemaVersion ?? "legacy")} is incompatible; retrain it`,
    );
  }
  if (
    !Array.isArray(file.featureNames) ||
    file.featureNames.length !== FEATURE_NAMES.length ||
    file.featureNames.some((name, index) => name !== FEATURE_NAMES[index])
  ) {
    throw new Error("feature schema does not match the current extractor; retrain the model");
  }
  if (
    !isFiniteArray(file.featureMean, FEATURE_NAMES.length) ||
    !isFiniteArray(file.featureStd, FEATURE_NAMES.length) ||
    file.featureStd.some((value) => value <= 0)
  ) {
    throw new Error("model normalization vectors are invalid");
  }
  if (
    typeof file.targetMean !== "number" ||
    !Number.isFinite(file.targetMean) ||
    typeof file.targetStd !== "number" ||
    !Number.isFinite(file.targetStd) ||
    file.targetStd <= 0 ||
    typeof file.trainedOn !== "number" ||
    !Number.isSafeInteger(file.trainedOn) ||
    file.trainedOn <= 0 ||
    typeof file.trainedAt !== "string" ||
      !Number.isFinite(Date.parse(file.trainedAt))
  ) {
    throw new Error("model target metadata is invalid");
  }
  validateNetwork(file.mlp, "primary network");
  if (!Array.isArray(file.ensemble) || file.ensemble.length === 0) {
    throw new Error("schema-v3 model ensemble must be a non-empty array");
  }
  for (const [index, json] of file.ensemble.entries()) {
    validateNetwork(json, `ensemble network ${index}`);
  }
  if (
    !file.ridge ||
    !Array.isArray(file.ridge.weights) ||
      file.ridge.weights.length !== FEATURE_NAMES.length ||
      file.ridge.weights.some((weight) => !Number.isFinite(weight)) ||
      !Number.isFinite(file.ridge.bias) ||
      !Number.isFinite(file.ridge.lambda) ||
      file.ridge.lambda <= 0 ||
      !Number.isSafeInteger(file.ridge.robustIterations) ||
      file.ridge.robustIterations < 0 ||
      file.ridge.robustIterations > 10 ||
      !Number.isFinite(file.ridge.huberDelta) ||
      file.ridge.huberDelta <= 0
  ) {
    throw new Error("ridge member has an incompatible shape");
  }
  RidgeModel.fromJSON(file.ridge);
  if (file.gbt === undefined) throw new Error("schema-v3 artifact requires a GBT member");
  const gbt = GradientBoostedTrees.fromJSON(file.gbt);
  if (gbt.featureCount !== FEATURE_NAMES.length) {
    throw new Error("GBT member has an incompatible feature count");
  }
  if (!Array.isArray(file.tailClassifiers) || file.tailClassifiers.length !== 3) {
    throw new Error("schema-v3 artifact requires three tail classifiers");
  }
  const tailClassifiers = file.tailClassifiers;
  let previousThreshold = 0;
  for (const [index, classifier] of tailClassifiers.entries()) {
    if (
      !classifier ||
      !Number.isFinite(classifier.thresholdTon) ||
      classifier.thresholdTon <= previousThreshold ||
      !Array.isArray(classifier.model?.weights) ||
      classifier.model.weights.length !== FEATURE_NAMES.length
    ) {
      throw new Error(`tail classifier ${index} has an incompatible shape`);
    }
    RidgeModel.fromJSON(classifier.model);
    previousThreshold = classifier.thresholdTon;
  }
  const networkCount = file.ensemble.length;
  const expectedStackFeatureNames = [
    ...Array.from({ length: networkCount }, (_, index) => `mlp_${index}`),
    "ridge_log_price",
    "gbt_log_price",
    ...tailClassifiers.map(
      ({ thresholdTon }) => `ridge_tail_gt_${thresholdTon}`,
    ),
  ];
  if (
    !file.stacker ||
    !Array.isArray(file.stackFeatureNames) ||
    file.stackFeatureNames.length !== expectedStackFeatureNames.length ||
    file.stackFeatureNames.some(
      (name, index) => name !== expectedStackFeatureNames[index],
    ) ||
    !Array.isArray(file.stacker.weights) ||
    file.stacker.weights.length !== expectedStackFeatureNames.length
  ) {
    throw new Error("stacker feature schema is incompatible");
  }
  RidgeModel.fromJSON(file.stacker);
  if (
    !file.calibration ||
    !Number.isFinite(file.calibration.residualP10Log) ||
      !Number.isFinite(file.calibration.residualP50Log) ||
      !Number.isFinite(file.calibration.residualP90Log) ||
      file.calibration.residualP10Log > file.calibration.residualP50Log ||
      file.calibration.residualP50Log > file.calibration.residualP90Log ||
      !Number.isSafeInteger(file.calibration.sampleSize) ||
      file.calibration.sampleSize <= 0 ||
      !Number.isFinite(file.calibration.nominalCoverage) ||
      file.calibration.nominalCoverage <= 0 ||
      file.calibration.nominalCoverage >= 1
  ) {
    throw new Error("model calibration metadata is invalid");
  }
  if (file.calibration.bins !== undefined) {
    if (!Array.isArray(file.calibration.bins) || file.calibration.bins.length < 2) {
      throw new Error("model calibration bins are invalid");
    }
    let previousMaximum = Number.NEGATIVE_INFINITY;
    let binnedSampleSize = 0;
    for (const bin of file.calibration.bins) {
      if (
        !Number.isFinite(bin.maxPredictedLog) ||
        bin.maxPredictedLog <= previousMaximum ||
        !Number.isFinite(bin.residualP10Log) ||
        !Number.isFinite(bin.residualP50Log) ||
        !Number.isFinite(bin.residualP90Log) ||
        bin.residualP10Log > bin.residualP50Log ||
        bin.residualP50Log > bin.residualP90Log ||
        !Number.isSafeInteger(bin.sampleSize) ||
        bin.sampleSize <= 0
      ) {
        throw new Error("model calibration bins are invalid");
      }
      previousMaximum = bin.maxPredictedLog;
      binnedSampleSize += bin.sampleSize;
    }
    if (binnedSampleSize !== file.calibration.sampleSize) {
      throw new Error("model calibration bin sample size is invalid");
    }
  }
  if (file.confidenceCalibration !== undefined) {
    const confidence = file.confidenceCalibration;
    if (
      confidence.definition !== "within-2x" ||
      !Number.isSafeInteger(confidence.sampleSize) ||
      confidence.sampleSize <= 0 ||
      !Array.isArray(confidence.bins) ||
      confidence.bins.length === 0
    ) {
      throw new Error("model confidence calibration is invalid");
    }
    let previousMaximum = Number.NEGATIVE_INFINITY;
    let previousProbability = 0;
    let sampleSize = 0;
    for (const bin of confidence.bins) {
      if (
        !Number.isFinite(bin.maxRawScore) ||
        bin.maxRawScore <= previousMaximum ||
        !Number.isFinite(bin.probabilityWithin2x) ||
        bin.probabilityWithin2x < previousProbability ||
        bin.probabilityWithin2x > 1 ||
        !Number.isSafeInteger(bin.sampleSize) ||
        bin.sampleSize <= 0
      ) {
        throw new Error("model confidence calibration is invalid");
      }
      previousMaximum = bin.maxRawScore;
      previousProbability = bin.probabilityWithin2x;
      sampleSize += bin.sampleSize;
    }
    if (sampleSize !== confidence.sampleSize) {
      throw new Error("model confidence calibration sample size is invalid");
    }
  }
  if (
    !file.oodCalibration ||
    !Number.isFinite(file.oodCalibration.distanceP50) ||
      !Number.isFinite(file.oodCalibration.distanceP90) ||
      !Number.isFinite(file.oodCalibration.distanceP99) ||
      file.oodCalibration.distanceP50 < 0 ||
      file.oodCalibration.distanceP50 > file.oodCalibration.distanceP90 ||
      file.oodCalibration.distanceP90 > file.oodCalibration.distanceP99
  ) {
    throw new Error("model OOD metadata is invalid");
  }
  if (
    typeof file.trainedThrough !== "string" ||
    !Number.isFinite(Date.parse(file.trainedThrough))
  ) {
    throw new Error("model trainedThrough timestamp is invalid");
  }
  if (
    typeof file.comparableBlendScale !== "number" ||
      !Number.isFinite(file.comparableBlendScale) ||
      file.comparableBlendScale < 0 ||
      file.comparableBlendScale > 0.65 ||
      file.comparablePipelineVersion !== COMPARABLE_PIPELINE_VERSION ||
      file.comparablePipelineHash !== comparablePipelineHash()
  ) {
    throw new Error("model comparable pipeline is incompatible; retrain the model");
  }
  if (
    !file.releaseGate ||
    typeof file.releaseGate.passed !== "boolean" ||
      ![
        "passed",
        "non-temporal-evaluation",
        "insufficient-test-data",
        "uncalibrated-confidence",
        "did-not-beat-baseline",
      ].includes(
        file.releaseGate.reason,
      ) ||
      !Number.isSafeInteger(file.releaseGate.minimumTestSize) ||
      file.releaseGate.minimumTestSize !== PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE ||
      !["globalMedian", "structuralMedian", "comparables"].includes(
        file.releaseGate.bestBaseline,
      ) ||
      !Number.isFinite(file.releaseGate.rmsleImprovement)
  ) {
    throw new Error("model release-gate metadata is invalid");
  }
  if (file.releaseGate.passed !== (file.releaseGate.reason === "passed")) {
    throw new Error("model release-gate result and reason are inconsistent");
  }
  const expectedFeatureHash = createHash("sha256")
    .update(FEATURE_NAMES.join("\n"))
    .digest("hex");
  if (
    file.featureSchemaHash !== expectedFeatureHash ||
    typeof file.dataHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(file.dataHash)
  ) {
    throw new Error("model schema/data hash metadata is invalid");
  }
  const split = file.split;
  if (
    !split ||
    !["temporal-group", "group-random", "random"].includes(split.strategy) ||
    !["temporal-group", "random"].includes(split.requestedStrategy) ||
    !Number.isSafeInteger(split.groupKeyVersion) ||
    split.groupKeyVersion < 1 ||
    !Number.isFinite(split.exactEventTimeCoverage) ||
    split.exactEventTimeCoverage < 0 ||
    split.exactEventTimeCoverage > 1 ||
    !Number.isSafeInteger(split.excludedForUnknownEventTime) ||
    split.excludedForUnknownEventTime < 0 ||
    !Number.isSafeInteger(split.excludedForTemporalOrdering) ||
    split.excludedForTemporalOrdering < 0 ||
    !Number.isFinite(split.validationFraction) ||
    split.validationFraction <= 0 ||
    !Number.isFinite(split.stackerFraction) ||
    split.stackerFraction <= 0 ||
    !Number.isFinite(split.calibrationFraction) ||
    split.calibrationFraction <= 0 ||
    !Number.isFinite(split.testFraction) ||
    split.testFraction <= 0 ||
    split.validationFraction +
        split.stackerFraction +
        split.calibrationFraction +
        split.testFraction >=
      0.8 ||
    [
      split.trainingThrough,
      split.validationThrough,
      split.stackerThrough,
      split.calibrationThrough,
      split.testThrough,
    ].some(
      (timestamp) =>
        timestamp !== undefined &&
        (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))),
    )
  ) {
    throw new Error("model split metadata is invalid");
  }
  const trainedAtMs = Date.parse(file.trainedAt!);
  const trainedThroughMs = Date.parse(file.trainedThrough);
  const splitThroughTimestamps = [
    split.trainingThrough,
    split.validationThrough,
    split.stackerThrough,
    split.calibrationThrough,
    split.testThrough,
  ].filter((timestamp): timestamp is string => timestamp !== undefined);
  if (
    trainedAtMs < trainedThroughMs ||
    splitThroughTimestamps.some((timestamp) => Date.parse(timestamp) > trainedThroughMs)
  ) {
    throw new Error("model training/split timestamps are inconsistent");
  }
  if (split.strategy === "temporal-group") {
    const chronology = [
      split.trainingThrough,
      split.validationThrough,
      split.stackerThrough,
      split.calibrationThrough,
      split.testThrough,
    ];
    if (
      split.exactEventTimeCoverage < 0.8 ||
      chronology.some((timestamp) => timestamp === undefined) ||
      chronology.some(
        (timestamp, index) =>
          index > 0 && Date.parse(timestamp!) <= Date.parse(chronology[index - 1]!),
      )
    ) {
      throw new Error("temporal model split is not strictly chronological");
    }
  }
  const metrics = file.metrics;
  if (
    !metrics ||
    !Number.isSafeInteger(metrics.bestEpoch) ||
    metrics.bestEpoch < 0 ||
    !Number.isFinite(metrics.trainMse) ||
    metrics.trainMse < 0 ||
    !Number.isFinite(metrics.validationMse) ||
    metrics.validationMse < 0 ||
    !Number.isSafeInteger(metrics.trainingSize) ||
    metrics.trainingSize <= 0 ||
    !Number.isSafeInteger(metrics.validationSize) ||
    metrics.validationSize <= 0 ||
    !Number.isSafeInteger(metrics.stackerSize) ||
    (metrics.stackerSize ?? 0) <= 0 ||
    !Number.isSafeInteger(metrics.calibrationSize) ||
    (metrics.calibrationSize ?? 0) <= 0 ||
    !Number.isSafeInteger(metrics.blendSelectionSize) ||
    (metrics.blendSelectionSize ?? -1) < 0 ||
    !Number.isSafeInteger(metrics.residualCalibrationSize) ||
    (metrics.residualCalibrationSize ?? 0) <= 0 ||
    !Number.isSafeInteger(metrics.confidenceCalibrationSize) ||
    (metrics.confidenceCalibrationSize ?? -1) < 0 ||
    !Number.isSafeInteger(metrics.calibrationUnusedSize) ||
    (metrics.calibrationUnusedSize ?? -1) < 0 ||
    !Number.isSafeInteger(metrics.finalCalibrationSize) ||
    metrics.finalCalibrationSize !== metrics.residualCalibrationSize ||
    (metrics.blendSelectionSize ?? 0) +
        (metrics.residualCalibrationSize ?? 0) +
        (metrics.confidenceCalibrationSize ?? 0) +
        (metrics.calibrationUnusedSize ?? 0) !==
      metrics.calibrationSize ||
    !Number.isSafeInteger(metrics.testSize) ||
    (metrics.testSize ?? 0) <= 0 ||
    !metrics.test ||
    metrics.test.count !== metrics.testSize ||
    !metrics.testInterval ||
    metrics.testInterval.count !== metrics.testSize
  ) {
    throw new Error("model evaluation metrics are incomplete");
  }
  const baselineAccuracy = metrics.baselines
    ? Object.values(metrics.baselines)
    : [];
  const baselineRanking = metrics.baselineTopTail
    ? Object.values(metrics.baselineTopTail)
    : [];
  if (
    !validAccuracyMetric(metrics.test, metrics.testSize!) ||
    !validAccuracyMetric(metrics.testModelOnly, metrics.testSize!) ||
    baselineAccuracy.length !== 3 ||
    baselineAccuracy.some((metric) => !validAccuracyMetric(metric, metrics.testSize!)) ||
    !validRankingMetric(metrics.testTopTail, metrics.testSize!) ||
    baselineRanking.length !== 3 ||
    baselineRanking.some((metric) => !validRankingMetric(metric, metrics.testSize!)) ||
    !Number.isFinite(metrics.testInterval!.coverage) ||
    metrics.testInterval!.coverage < 0 ||
    metrics.testInterval!.coverage > 1 ||
    !Number.isFinite(metrics.testInterval!.meanWidthLog) ||
    metrics.testInterval!.meanWidthLog < 0 ||
    !Number.isFinite(metrics.ensembleTrainMse) ||
    (metrics.ensembleTrainMse ?? -1) < 0 ||
    !Number.isFinite(metrics.ensembleValidationMse) ||
    (metrics.ensembleValidationMse ?? -1) < 0 ||
    !Number.isFinite(metrics.gbtTrainMse) ||
    (metrics.gbtTrainMse ?? -1) < 0 ||
    !Number.isFinite(metrics.gbtValidationMse) ||
    (metrics.gbtValidationMse ?? -1) < 0
  ) {
    throw new Error("model test/baseline metrics are invalid");
  }
  const orderedBaselines = [
    ["globalMedian", metrics.baselines!.globalMedian],
    ["structuralMedian", metrics.baselines!.structuralMedian],
    ["comparables", metrics.baselines!.comparables],
  ] as const;
  const bestBaseline = [...orderedBaselines].sort(
    (left, right) => left[1].rmsle - right[1].rmsle,
  )[0];
  const expectedRmsleImprovement =
    bestBaseline[1].rmsle > 0
      ? (bestBaseline[1].rmsle - metrics.test!.rmsle) / bestBaseline[1].rmsle
      : 0;
  const bestBaselineTailRecall = Math.max(
    metrics.baselineTopTail!.globalMedian.recall,
    metrics.baselineTopTail!.structuralMedian.recall,
    metrics.baselineTopTail!.comparables.recall,
  );
  const accuracyPass =
    expectedRmsleImprovement >= 0.02 &&
    metrics.test!.within2x >= bestBaseline[1].within2x - 0.01;
  const discoveryPass =
    metrics.testTopTail!.recall >= bestBaselineTailRecall + 0.05 &&
    metrics.test!.rmsle <= bestBaseline[1].rmsle * 1.15;
  const expectedGatePassed =
    split.strategy === "temporal-group" &&
    metrics.testSize! >= PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE &&
    file.confidenceCalibration !== undefined &&
    (accuracyPass || discoveryPass);
  if (
    file.releaseGate.bestBaseline !== bestBaseline[0] ||
    Math.abs(file.releaseGate.rmsleImprovement - expectedRmsleImprovement) > 1e-9 ||
    file.releaseGate.passed !== expectedGatePassed
  ) {
    throw new Error("model release-gate result contradicts benchmark metrics");
  }
  if (
    file.calibration.sampleSize !== metrics.residualCalibrationSize ||
    (file.confidenceCalibration !== undefined &&
      file.confidenceCalibration.sampleSize !== metrics.confidenceCalibrationSize) ||
    file.releaseGate.passed &&
      ((metrics.testSize ?? 0) < PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE ||
        split.strategy !== "temporal-group" ||
        file.confidenceCalibration === undefined)
  ) {
    throw new Error("model calibration, evaluation and release metadata are inconsistent");
  }
  const confidenceCalibrated = file.confidenceCalibration !== undefined;
  const expectedReleaseReason: PriceModelFile["releaseGate"]["reason"] =
    split.strategy !== "temporal-group"
      ? "non-temporal-evaluation"
      : metrics.testSize! < PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE
        ? "insufficient-test-data"
        : !confidenceCalibrated
          ? "uncalibrated-confidence"
          : file.releaseGate.passed
            ? "passed"
            : "did-not-beat-baseline";
  if (file.releaseGate.reason !== expectedReleaseReason) {
    throw new Error("model release-gate reason contradicts evaluation metadata");
  }
  if (
    !file.capabilities ||
    file.capabilities.intervalCalibrated !== true ||
    file.capabilities.confidenceCalibrated !== confidenceCalibrated ||
    file.capabilities.temporalEvaluation !== (split.strategy === "temporal-group") ||
    file.capabilities.approved !== file.releaseGate.passed ||
    (file.capabilities.approved &&
      (!file.capabilities.temporalEvaluation || !confidenceCalibrated))
  ) {
    throw new Error("model capability metadata is inconsistent");
  }
  return file as PriceModelFile;
}

function readAndValidateModel(path = MODEL_PATH): { file: PriceModelFile; mtimeMs: number } {
  if (!existsSync(path)) {
    throw new Error(
      `Price model was not found at ${path}. Run collect-sales and train-price first.`,
    );
  }
  const mtimeMs = statSync(path).mtimeMs;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { file: validateModelFile(parsed), mtimeMs };
}

function isDefaultModelPath(path: string): boolean {
  return resolve(path) === resolve(MODEL_PATH);
}

function modelDataCurrent(file: PriceModelFile, path: string): boolean {
  // Explicit custom paths are artifact-inspection/test fixtures and have no
  // declared sold-history contract. Production inference always loads the
  // default path and therefore always executes the strict branch below.
  if (!isDefaultModelPath(path)) return true;
  if (!existsSync(HISTORY_PATH)) return false;
  return loadComparableHistory().length > 0 && cachedHistory?.dataHash === file.dataHash;
}

function staleModelError(): Error {
  return new Error(
    "Price model is stale: data/sold-history.json no longer matches the corpus " +
      "used for training. Retrain the price model before inference.",
  );
}

function instantiateModels(file: PriceModelFile): InstantiatedPriceModels {
  const jsonModels = file.ensemble;
  const models: Array<MLP | RidgeModel> = jsonModels.map((json) => MLP.fromJSON(json));
  models.push(RidgeModel.fromJSON(file.ridge));
  const gbt = GradientBoostedTrees.fromJSON(file.gbt);
  const tailClassifiers = file.tailClassifiers.map(({ model }) =>
    RidgeModel.fromJSON(model),
  );
  const stacker = RidgeModel.fromJSON(file.stacker);
  const probe = new Array<number>(FEATURE_NAMES.length).fill(0);
  const stackProbe = models.map((model, index) => {
    const output = model.predict(probe)[0];
    if (!Number.isFinite(output)) {
      throw new Error(`model member ${index} failed a finite inference probe`);
    }
    return output;
  });
  const gbtOutput = gbt.predict(probe);
  if (!Number.isFinite(gbtOutput)) throw new Error("GBT failed a finite inference probe");
  stackProbe.push(gbtOutput);
  for (const [index, classifier] of tailClassifiers.entries()) {
    const output = classifier.predict(probe)[0];
    if (!Number.isFinite(output)) {
      throw new Error(`tail classifier ${index} failed a finite inference probe`);
    }
    stackProbe.push(output);
  }
  if (!Number.isFinite(stacker.predict(stackProbe)[0])) {
    throw new Error("stacker failed a finite inference probe");
  }
  return { models, gbt, tailClassifiers, stacker };
}

export function inspectPriceModel(path = MODEL_PATH): PriceModelStatus {
  if (!existsSync(path)) return { exists: false, valid: false, reason: "file not found" };
  try {
    const { file } = readAndValidateModel(path);
    instantiateModels(file);
    const dataCurrent = modelDataCurrent(file, path);
    return {
      exists: true,
      valid: true,
      approved: artifactApproved(file) && dataCurrent,
      confidenceCalibrated: file.confidenceCalibration !== undefined,
      dataCurrent,
      stale: !dataCurrent,
      ...(file.split?.strategy !== "temporal-group"
        ? { releaseGateReason: "non-temporal-evaluation" as const }
        : file.confidenceCalibration === undefined
          ? { releaseGateReason: "uncalibrated-confidence" as const }
          : file.releaseGate
            ? { releaseGateReason: file.releaseGate.reason }
            : {}),
      ...(file.split ? { splitStrategy: file.split.strategy } : {}),
      trainedAt: file.trainedAt,
      trainedOn: file.trainedOn,
      schemaVersion: file.schemaVersion,
      ...(!dataCurrent
        ? { reason: "sold-history corpus changed or is missing; retrain the price model" }
        : {}),
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function priceModelExists(path = MODEL_PATH): boolean {
  return inspectPriceModel(path).valid;
}

/** Accuracy-sensitive workflows should require this, not mere schema compatibility. */
export function priceModelApproved(path = MODEL_PATH): boolean {
  const status = inspectPriceModel(path);
  return status.valid && status.approved === true && status.confidenceCalibrated === true;
}

function loadModel(): LoadedPriceModel {
  const path = resolve(MODEL_PATH);
  if (
    cachedModel &&
    cachedModel.path === path &&
    existsSync(path) &&
    statSync(path).mtimeMs === cachedModel.mtimeMs
  ) {
    const dataCurrent = modelDataCurrent(cachedModel.file, path);
    if (!dataCurrent) throw staleModelError();
    cachedModel.dataCurrent = dataCurrent;
    return cachedModel;
  }
  const { file, mtimeMs } = readAndValidateModel(path);
  const instantiated = instantiateModels(file);
  const dataCurrent = modelDataCurrent(file, path);
  if (!dataCurrent) throw staleModelError();
  cachedModel = { ...instantiated, file, mtimeMs, path, dataCurrent };
  return cachedModel;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length,
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function valuationTimestamp(value: ComparableTimestamp): number {
  const raw =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(raw)) {
    throw new RangeError(
      "valuationAt must be a valid date or Unix millisecond timestamp.",
    );
  }
  const normalized = new Date(raw).getTime();
  if (!Number.isFinite(normalized)) {
    throw new RangeError(
      "valuationAt must be a valid date or Unix millisecond timestamp.",
    );
  }
  return normalized;
}

function assertHistoricalArtifactCutoff(
  file: PriceModelFile,
  valuationAt: ComparableTimestamp | undefined,
): void {
  if (valuationAt === undefined) return;
  const valuationAtMs = valuationTimestamp(valuationAt);
  if (file.trainedThrough === undefined) return;
  const trainedThroughMs = Date.parse(file.trainedThrough);
  // Model-file validation normally guarantees this, but keep the invariant
  // local to this safety boundary as well.
  if (!Number.isFinite(trainedThroughMs)) {
    throw new Error("model trainedThrough timestamp is invalid");
  }
  if (valuationAtMs <= trainedThroughMs) {
    throw new RangeError(
      `valuationAt (${new Date(valuationAtMs).toISOString()}) is not strictly after ` +
        `model trainedThrough (${new Date(trainedThroughMs).toISOString()}). ` +
        "Historical inference with this artifact would leak future training data; " +
        "use a cutoff/walk-forward artifact trained only through valuationAt.",
    );
  }
}

function confidenceLabel(score: number): PriceConfidence {
  if (score >= 0.72) return "high";
  if (score >= 0.42) return "medium";
  return "low";
}

function blendLogPrice(left: number, right: number, rightWeight: number): number {
  return priceFromLog(
    Math.log1p(left) * (1 - rightWeight) + Math.log1p(right) * rightWeight,
  );
}

function loadComparableHistory(): ReturnType<typeof loadSoldHistory> {
  if (!existsSync(HISTORY_PATH)) return [];
  const path = resolve(HISTORY_PATH);
  const mtimeMs = statSync(HISTORY_PATH).mtimeMs;
  if (cachedHistory?.path === path && cachedHistory.mtimeMs === mtimeMs) {
    return cachedHistory.records;
  }
  const records = loadSoldHistory(path);
  cachedHistory = { records, mtimeMs, path, dataHash: priceHistoryDataHash(records) };
  return records;
}

function comparableEstimate(
  username: string,
  options: PricePredictionOptions,
): ComparableEstimate | null {
  if (options.includeComparables === false) return null;
  const history = loadComparableHistory();
  if (history.length === 0) return null;
  return estimateProductionComparablePrice(
    username,
    history,
    options.valuationAt ?? new Date(),
    options.excludeEventId === undefined
      ? undefined
      : { excludeEventId: options.excludeEventId },
  );
}

function liquidityEstimate(
  username: string,
  predictedAskTon: number,
  options: PricePredictionOptions,
): PriceLiquidityPrediction | undefined {
  const includeLiquidity =
    options.includeLiquidity ?? options.includeComparables !== false;
  if (!includeLiquidity || !existsSync(DEFAULT_MARKET_EVENTS_PATH)) return undefined;
  if (
    options.askingPriceTon !== undefined &&
    (!Number.isFinite(options.askingPriceTon) || options.askingPriceTon <= 0)
  ) {
    throw new RangeError("askingPriceTon must be a positive finite number.");
  }

  try {
    const mtimeMs = statSync(DEFAULT_MARKET_EVENTS_PATH).mtimeMs;
    if (cachedLiquidityHistory?.mtimeMs !== mtimeMs) {
      const events = loadMarketEvents(DEFAULT_MARKET_EVENTS_PATH);
      cachedLiquidityHistory = {
        events,
        observations: marketEventsToLiquidityListings(events),
        mtimeMs,
      };
    }
    const built = cachedLiquidityHistory.observations;
    if (built.observations.length === 0) return undefined;
    const estimate = estimateLiquidity(
      {
        username,
        askTon: options.askingPriceTon ?? predictedAskTon,
      },
      built.observations,
      options.valuationAt ?? new Date(),
      options.excludeEventId === undefined
        ? {}
        : { excludeObservationIds: [options.excludeEventId] },
    );
    return {
      saleProbability30d: estimate.saleProbability30d,
      saleProbability90d: estimate.saleProbability90d,
      saleProbability365d: estimate.saleProbability365d,
      medianDaysToSale: estimate.medianDaysToSale,
      expectedSalePriceTon: estimate.expectedSalePriceTon,
      confidenceScore: estimate.confidence,
      outOfDistribution: estimate.outOfDistribution,
      oodReasons: estimate.oodReasons,
      effectiveSampleSize: estimate.effectiveSampleSize,
      usedObservationCount: estimate.usedObservationCount,
      buildDiagnostics: built.diagnostics,
    };
  } catch {
    // Listing evidence is optional. A corrupt or incomplete warehouse must
    // not erase an otherwise valid local price estimate.
    return undefined;
  }
}

/** Fully local TON-only inference. It never calls CoinGecko or another service. */
export function predictPriceTon(
  username: string,
  options: PricePredictionOptions = {},
): PricePredictionTon {
  // Validate caller input before touching artifact/data state so malformed
  // requests are reported deterministically even when retraining is pending.
  if (options.valuationAt !== undefined) valuationTimestamp(options.valuationAt);
  const { models, gbt, tailClassifiers, stacker, file, dataCurrent } = loadModel();
  assertHistoricalArtifactCutoff(file, options.valuationAt);
  const features = extractFeatures(username);
  if (
    features.length !== FEATURE_NAMES.length ||
    features.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`Invalid feature vector for @${username}.`);
  }
  const normalized = features.map(
    (value, index) => (value - file.featureMean[index]) / file.featureStd[index],
  );
  if (normalized.some((value) => !Number.isFinite(value))) {
    throw new Error("Model normalization produced a non-finite value.");
  }

  const priceModelOutputs = models.map((model) => model.predict(normalized)[0]);
  priceModelOutputs.push(gbt.predict(normalized));
  const tailOutputs = tailClassifiers.map(
    (classifier) => classifier.predict(normalized)[0],
  );
  const stackInputs = [...priceModelOutputs, ...tailOutputs];
  if (stackInputs.some((value) => !Number.isFinite(value))) {
    throw new Error("Price model produced a non-finite value.");
  }
  const medianNormalized = stacker.predict(stackInputs)[0];
  if (!Number.isFinite(medianNormalized)) {
    throw new Error("Price-model stacker produced a non-finite value.");
  }
  const disagreementNormalized = standardDeviation(priceModelOutputs);
  const baseLog = medianNormalized * file.targetStd + file.targetMean;
  const disagreementLog = disagreementNormalized * file.targetStd;
  const modelBaseTon = priceFromLog(baseLog);
  const comparable = comparableEstimate(username, options);
  const comparableUsable = comparable !== null && comparable.p50Ton > 0;
  const comparableWeight = comparableUsable
    ? comparableBlendWeight(comparable.confidence, file.comparableBlendScale)
    : 0;
  const finalBaseTon = comparableUsable
    ? blendLogPrice(modelBaseTon, comparable.p50Ton, comparableWeight)
    : modelBaseTon;
  const finalBaseLog = Math.log1p(finalBaseTon);
  const selectedCalibration = selectPriceCalibrationBin(file.calibration, finalBaseLog);
  const featureDistance = Math.sqrt(
    normalized.reduce((sum, value) => sum + value * value, 0) / normalized.length,
  );
  const ood = file.oodCalibration;
  const oodScore = clamp01(
    (featureDistance - ood.distanceP90) /
      Math.max(ood.distanceP99 - ood.distanceP90, 1e-9),
  );

  // Residuals were calibrated after retrieval blending. These additions only
  // widen the conformal interval for feature OOD or unusually divergent
  // retrieval evidence; they never narrow its empirical base width.
  const retrievalDisagreementLog =
    comparableUsable && comparableWeight > 0
      ? Math.abs(Math.log1p(modelBaseTon) - Math.log1p(comparable.p50Ton)) * 0.2
      : 0;
  const extraWidthLog =
    oodScore *
      (disagreementLog * PRICE_DISAGREEMENT_OOD_INTERVAL_FACTOR +
        PRICE_OOD_INTERVAL_LOG_WIDTH) +
    retrievalDisagreementLog;
  const p50Log = finalBaseLog + selectedCalibration.residualP50Log;
  const p10Log = Math.min(
    p50Log,
    finalBaseLog + selectedCalibration.residualP10Log - extraWidthLog,
  );
  const p90Log = Math.max(
    p50Log,
    finalBaseLog + selectedCalibration.residualP90Log + extraWidthLog,
  );
  const baseConfidenceScore = rawPriceConfidenceScore(
    oodScore,
    disagreementLog,
    selectedCalibration.sampleSize,
  );
  const p10Ton = priceFromLog(p10Log);
  const p50Ton = priceFromLog(p50Log);
  const p90Ton = priceFromLog(p90Log);
  const modelP50Ton = priceFromLog(baseLog + file.calibration.residualP50Log);
  let combinedConfidence = comparableUsable
    ? combinedRawPriceConfidence(
        baseConfidenceScore,
        modelBaseTon,
        comparable.p50Ton,
        comparable.confidence,
        file.comparableBlendScale,
      )
    : baseConfidenceScore;
  let combinedOodScore = oodScore;
  if (comparableUsable && comparableWeight > 0) {
    combinedOodScore = Math.min(
      1,
      oodScore * (1 - comparableWeight) +
        (comparable.outOfDistribution ? 1 : 1 - comparable.confidence) * comparableWeight,
    );
  }
  combinedConfidence = applyPriceConfidenceCalibration(
    file.confidenceCalibration,
    combinedConfidence,
  );
  const liquidity = liquidityEstimate(username, p50Ton, options);
  const outOfDistribution =
    oodScore > 0 ||
    (comparableUsable && comparableWeight > 0 && comparable.outOfDistribution);

  return {
    ton: p50Ton,
    p10Ton,
    p50Ton,
    p90Ton,
    confidence: confidenceLabel(combinedConfidence),
    confidenceScore: combinedConfidence,
    confidenceDefinition: file.confidenceCalibration
      ? "probability-within-2x"
      : "heuristic-score",
    oodScore: combinedOodScore,
    featureDistance,
    modelDisagreementLog: disagreementLog,
    trainedAt: file.trainedAt,
    trainedThrough: file.trainedThrough,
    modelP50Ton,
    ...(liquidity ? { liquidity } : {}),
    releaseGatePassed: artifactApproved(file),
    outOfDistribution,
    releaseGateReason: file.releaseGate.reason,
    splitStrategy: file.split.strategy,
    dataCurrent,
    ...(comparableUsable
      ? {
          comparableP50Ton: comparable.p50Ton,
          comparableEffectiveSampleSize: comparable.effectiveSampleSize,
          topComparables: comparable.topComparables,
        }
      : {}),
  };
}

/**
 * Adds optional current fiat display values. A rate outage no longer prevents
 * local TON inference or causes candidates to be discarded.
 */
export async function predictPrice(
  username: string,
  options: PricePredictionOptions = {},
): Promise<PricePrediction> {
  const prediction = predictPriceTon(username, options);
  try {
    const rates = await getRates();
    const median = convertTon(prediction.p50Ton, rates);
    const lower = convertTon(prediction.p10Ton, rates);
    const upper = convertTon(prediction.p90Ton, rates);
    return {
      ...prediction,
      usd: median.usd,
      rub: median.rub,
      p10Usd: lower.usd,
      p90Usd: upper.usd,
      p10Rub: lower.rub,
      p90Rub: upper.rub,
      rateFetchedAt: rates.fetchedAt,
    };
  } catch (error) {
    return {
      ...prediction,
      usd: null,
      rub: null,
      p10Usd: null,
      p90Usd: null,
      p10Rub: null,
      p90Rub: null,
      ratesError: error instanceof Error ? error.message : String(error),
    };
  }
}
