import { createHash } from "node:crypto";
import {
  GradientBoostedTrees,
  type GradientBoostedTreesJSON,
} from "../ml/gradientBoostedTrees.js";
import { MLP, type MLPJSON } from "../ml/mlp.js";
import { RidgeModel, type RidgeModelJSON } from "../ml/ridge.js";
import { loadSoldHistory } from "../priceData/store.js";
import type { SoldRecord } from "../priceData/soldHistory.js";
import { deterministicShuffle as sharedDeterministicShuffle } from "../random.js";
import { writeJsonAtomic } from "../storage/atomic.js";
import {
  evaluatePriceIntervals,
  evaluatePricePredictions,
  evaluateTopTailRecall,
  isWithinPriceFactor,
  priceFromLog,
  quantile,
  type PriceAccuracyMetrics,
  type PriceIntervalMetrics,
  type PriceRankingMetrics,
} from "./evaluation.js";
import { extractFeatures, FEATURE_NAMES } from "./features.js";
import {
  COMPARABLE_PIPELINE_SIGNATURE,
  COMPARABLE_PIPELINE_VERSION,
  estimateProductionComparablePrice,
} from "./comparables.js";
import { PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE } from "./policy.js";

const MODEL_DIR = "models";
const DEFAULT_SPLIT_SEED = 0x51f15e;
const DEFAULT_CALIBRATION_FRACTION = 0.1;
const DEFAULT_TEST_FRACTION = 0.1;
const DEFAULT_STACKER_FRACTION = 0.1;
export const PRICE_MODEL_SCHEMA_VERSION = 3;
export const MODEL_PATH = `${MODEL_DIR}/price-mlp.json`;
export const PRICE_DISAGREEMENT_OOD_INTERVAL_FACTOR = 0.25;
export const PRICE_OOD_INTERVAL_LOG_WIDTH = Math.log(1.5);

export interface PriceModelMetrics {
  /** Zero-based epoch selected for the primary member of the ensemble. */
  bestEpoch: number;
  /** Primary/backward-compatible network MSE in normalized log-price space. */
  trainMse: number;
  /** Primary/backward-compatible network MSE in normalized log-price space. */
  validationMse: number;
  ensembleTrainMse?: number;
  ensembleValidationMse?: number;
  gbtTrainMse?: number;
  gbtValidationMse?: number;
  trainingSize: number;
  validationSize: number;
  calibrationSize?: number;
  blendSelectionSize?: number;
  residualCalibrationSize?: number;
  confidenceCalibrationSize?: number;
  /** Calibration rows intentionally unused to preserve lexical/temporal independence. */
  calibrationUnusedSize?: number;
  /** @deprecated schema-v3 compatibility alias for residualCalibrationSize. */
  finalCalibrationSize?: number;
  stackerSize?: number;
  testSize?: number;
  /** Metrics on the final untouched holdout; inspect `split.strategy` for chronology. */
  test?: PriceAccuracyMetrics;
  testModelOnly?: PriceAccuracyMetrics;
  testInterval?: PriceIntervalMetrics;
  baselines?: {
    globalMedian: PriceAccuracyMetrics;
    structuralMedian: PriceAccuracyMetrics;
    comparables: PriceAccuracyMetrics;
  };
  testTopTail?: PriceRankingMetrics;
  baselineTopTail?: {
    globalMedian: PriceRankingMetrics;
    structuralMedian: PriceRankingMetrics;
    comparables: PriceRankingMetrics;
  };
  testSlices?: Record<string, PriceAccuracyMetrics>;
  comparableBlendScale?: number;
}

export interface PriceModelReleaseGate {
  passed: boolean;
  reason:
    | "passed"
    | "non-temporal-evaluation"
    | "insufficient-test-data"
    | "uncalibrated-confidence"
    | "did-not-beat-baseline";
  minimumTestSize: number;
  bestBaseline: "globalMedian" | "structuralMedian" | "comparables";
  rmsleImprovement: number;
}

export interface PriceModelCalibration {
  residualP10Log: number;
  residualP50Log: number;
  residualP90Log: number;
  sampleSize: number;
  nominalCoverage: number;
  /** Mondrian residual bins ordered by the model's uncalibrated log estimate. */
  bins?: PriceModelCalibrationBin[];
}

export interface PriceModelCalibrationBin {
  maxPredictedLog: number;
  residualP10Log: number;
  residualP50Log: number;
  residualP90Log: number;
  sampleSize: number;
}

export interface PriceModelOodCalibration {
  distanceP50: number;
  distanceP90: number;
  distanceP99: number;
}

export interface PriceConfidenceCalibrationBin {
  maxRawScore: number;
  probabilityWithin2x: number;
  sampleSize: number;
}

export interface PriceConfidenceCalibration {
  definition: "within-2x";
  sampleSize: number;
  bins: PriceConfidenceCalibrationBin[];
}

export interface PriceModelSplitMetadata {
  /** Strategy actually applied after checking timestamp coverage. */
  strategy: "temporal-group" | "group-random" | "random";
  requestedStrategy: "temporal-group" | "random";
  groupKeyVersion: number;
  exactEventTimeCoverage: number;
  /** Unknown-time rows dropped because their observation time crossed a cutoff. */
  excludedForUnknownEventTime: number;
  /** Exact-time rows dropped to make every cohort strictly chronological. */
  excludedForTemporalOrdering: number;
  validationFraction: number;
  calibrationFraction: number;
  stackerFraction: number;
  testFraction: number;
  trainingThrough?: string;
  validationThrough?: string;
  stackerThrough?: string;
  calibrationThrough?: string;
  testThrough?: string;
}

export interface PriceTailClassifierFile {
  thresholdTon: number;
  model: RidgeModelJSON;
}

export interface PriceModelCapabilities {
  intervalCalibrated: true;
  confidenceCalibrated: boolean;
  temporalEvaluation: boolean;
  approved: boolean;
}

export interface PriceModelFile {
  schemaVersion: typeof PRICE_MODEL_SCHEMA_VERSION;
  /** Kept as the primary network for backward compatibility with older readers. */
  mlp: MLPJSON;
  /** Independently initialized networks whose median is used for inference. */
  ensemble: MLPJSON[];
  /** Robust linear member that is particularly effective on hashed n-grams. */
  ridge: RidgeModelJSON;
  /** Non-linear tabular member required by the strict schema-v3 contract. */
  gbt: GradientBoostedTreesJSON;
  /** Ordinal high-value signals consumed by the out-of-fold stacker. */
  tailClassifiers: PriceTailClassifierFile[];
  /** Meta-regressor fitted on its own holdout, never on early-stop validation or test. */
  stacker: RidgeModelJSON;
  stackFeatureNames: string[];
  /** Validation/calibration-selected upper scale for retrieval blending. */
  comparableBlendScale: number;
  comparablePipelineVersion: typeof COMPARABLE_PIPELINE_VERSION;
  comparablePipelineHash: string;
  featureMean: number[];
  featureStd: number[];
  featureNames: string[];
  featureSchemaHash: string;
  targetMean: number;
  targetStd: number;
  trainedOn: number;
  trainedAt: string;
  trainedThrough: string;
  dataHash: string;
  calibration: PriceModelCalibration;
  oodCalibration: PriceModelOodCalibration;
  confidenceCalibration?: PriceConfidenceCalibration;
  split: PriceModelSplitMetadata;
  releaseGate: PriceModelReleaseGate;
  capabilities: PriceModelCapabilities;
  metrics: PriceModelMetrics;
}

export interface PriceTrainingOptions {
  epochs?: number;
  hiddenSizes?: number[];
  valFraction?: number;
  calibrationFraction?: number;
  stackerFraction?: number;
  testFraction?: number;
  /** Controls cohort tie-breaking and network initialization. */
  seed?: number;
  batchSize?: number;
  learningRate?: number;
  ensembleSize?: number;
  ridgeLambda?: number;
  gbtTrees?: number;
  gbtMaxDepth?: number;
  stackerLambda?: number;
  earlyStoppingRounds?: number;
  splitStrategy?: "temporal-group" | "random";
}

export interface PreparedPriceTrainingData {
  trainInputs: number[][];
  trainTargets: number[][];
  /** Parser/evidence quality weights aligned with the training rows. */
  trainWeights: number[];
  validationInputs: number[][];
  validationTargets: number[][];
  calibrationInputs: number[][];
  calibrationTargets: number[][];
  stackerInputs: number[][];
  stackerTargets: number[][];
  testInputs: number[][];
  testTargets: number[][];
  trainingRecords: SoldRecord[];
  validationRecords: SoldRecord[];
  calibrationRecords: SoldRecord[];
  stackerRecords: SoldRecord[];
  testRecords: SoldRecord[];
  featureMean: number[];
  featureStd: number[];
  targetMean: number;
  targetStd: number;
  split: PriceModelSplitMetadata;
}

interface RecordPartitions {
  trainingRecords: SoldRecord[];
  validationRecords: SoldRecord[];
  calibrationRecords: SoldRecord[];
  stackerRecords: SoldRecord[];
  testRecords: SoldRecord[];
}

interface PartitionResult {
  partitions: RecordPartitions;
  strategy: PriceModelSplitMetadata["strategy"];
  excludedForUnknownEventTime: number;
  excludedForTemporalOrdering: number;
}

interface CalibrationSubsets {
  blendSelectionIndexes: number[];
  residualCalibrationIndexes: number[];
  confidenceCalibrationIndexes: number[];
}

function mean(xs: readonly number[]): number {
  return xs.reduce((sum, value) => sum + value, 0) / xs.length;
}

function std(xs: readonly number[], average: number): number {
  const variance = xs.reduce((sum, value) => sum + (value - average) ** 2, 0) / xs.length;
  const result = Math.sqrt(variance);
  return result > 1e-12 ? result : 1;
}

function standardDeviation(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const average = mean(xs);
  return Math.sqrt(
    xs.reduce((sum, value) => sum + (value - average) ** 2, 0) / xs.length,
  );
}

function validTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Evidence quality affects fitting rather than only appearing in diagnostics.
 * Legacy rows receive one common neutral weight, preserving their relative
 * distribution while allowing exact future observations to carry more weight
 * than fallback-parser candidates.
 */
export function soldRecordTrainingWeight(record: SoldRecord): number {
  const confidenceWeight =
    record.confidence === "high"
      ? 1
      : record.confidence === "medium"
        ? 0.75
        : record.confidence === "low"
          ? 0.4
          : 0.65;
  const parserWeight =
    record.provenance?.parser === "fragment-sold-table"
      ? 1
      : record.provenance?.parser === "fragment-embedded-json"
        ? 0.9
        : record.provenance?.parser === "fragment-text"
          ? 0.7
          : 1;
  const timestampWeight = record.saleAt ? 1 : 0.9;
  return Math.max(0.2, Math.min(1, confidenceWeight * parserWeight * timestampWeight));
}

export function soldRecordTimestamp(record: SoldRecord): number {
  const event = record as SoldRecord & {
    saleAt?: string;
    soldAt?: string;
    eventAt?: string;
    timestamp?: string;
  };
  return (
    validTimestamp(event.saleAt) ??
    validTimestamp(event.soldAt) ??
    validTimestamp(event.eventAt) ??
    validTimestamp(event.timestamp) ??
    validTimestamp(record.scrapedAt) ??
    0
  );
}

/** Exact transaction/market time only; observation time is deliberately excluded. */
export function soldRecordExactEventTimestamp(record: SoldRecord): number | null {
  const event = record as SoldRecord & {
    soldAt?: string;
    eventAt?: string;
    timestamp?: string;
  };
  return (
    validTimestamp(record.saleAt) ??
    validTimestamp(event.soldAt) ??
    validTimestamp(event.eventAt) ??
    validTimestamp(event.timestamp)
  );
}

/**
 * Groups obvious generated variants and repeated sales. A dataset with too
 * few families falls back to an explicitly non-grouped, non-approved random
 * strategy; the group key itself is never weakened to manufacture groups.
 */
export function priceLexicalFamily(username: string): string {
  return username
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/_+/g, "_");
}

function stableTieBreaker(value: string, seed: number): string {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

function latestIso(records: readonly SoldRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  const timestamp = Math.max(...records.map(soldRecordTimestamp));
  return timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
}

function requestedHoldoutSizes(
  count: number,
  valFraction: number,
  stackerFraction: number,
  calibrationFraction: number,
  testFraction: number,
): { validation: number; stacker: number; calibration: number; test: number } {
  let validation = Math.max(1, Math.floor(count * valFraction));
  let stacker = count >= 8 ? Math.max(1, Math.floor(count * stackerFraction)) : 0;
  let calibration = count >= 8 ? Math.max(1, Math.floor(count * calibrationFraction)) : 0;
  let test = count >= 10 ? Math.max(1, Math.floor(count * testFraction)) : 0;
  while (validation + stacker + calibration + test >= count) {
    if (test > 0) test--;
    else if (calibration > 0) calibration--;
    else if (stacker > 0) stacker--;
    else validation--;
  }
  return { validation, stacker, calibration, test };
}

function randomPartitions(
  history: readonly SoldRecord[],
  sizes: ReturnType<typeof requestedHoldoutSizes>,
  seed: number,
): RecordPartitions {
  const shuffled = deterministicShuffle(history, seed);
  let cursor = 0;
  const testRecords = shuffled.slice(cursor, (cursor += sizes.test));
  const calibrationRecords = shuffled.slice(cursor, (cursor += sizes.calibration));
  const stackerRecords = shuffled.slice(cursor, (cursor += sizes.stacker));
  const validationRecords = shuffled.slice(cursor, (cursor += sizes.validation));
  const trainingRecords = shuffled.slice(cursor);
  return {
    trainingRecords,
    validationRecords,
    stackerRecords,
    calibrationRecords,
    testRecords,
  };
}

function groupedRecords(history: readonly SoldRecord[]): Map<string, SoldRecord[]> {
  const initialGroups = new Map<string, SoldRecord[]>();
  for (const record of history) {
    const family = priceLexicalFamily(record.username);
    const values = initialGroups.get(family) ?? [];
    values.push(record);
    initialGroups.set(family, values);
  }

  return initialGroups;
}

export function splitIndependentCalibrationCohorts(
  records: readonly SoldRecord[],
  strategy: PriceModelSplitMetadata["strategy"],
  seed: number,
): CalibrationSubsets {
  const groups = new Map<string, number[]>();
  records.forEach((record, index) => {
    const key = priceLexicalFamily(record.username);
    const indexes = groups.get(key) ?? [];
    indexes.push(index);
    groups.set(key, indexes);
  });
  if (groups.size < 2) {
    return {
      blendSelectionIndexes: [],
      residualCalibrationIndexes: records.map((_, index) => index),
      confidenceCalibrationIndexes: [],
    };
  }

  const ordered = [...groups.entries()].sort((left, right) => {
    if (strategy === "temporal-group") {
      const firstTimestamp = (indexes: readonly number[]): number =>
        Math.min(
          ...indexes.map(
            (index) =>
              soldRecordExactEventTimestamp(records[index]) ??
              soldRecordTimestamp(records[index]),
          ),
        );
      const delta = firstTimestamp(left[1]) - firstTimestamp(right[1]);
      if (delta !== 0) return delta;
    }
    return stableTieBreaker(left[0], seed ^ 0x2c1b3c6d).localeCompare(
      stableTieBreaker(right[0], seed ^ 0x2c1b3c6d),
    );
  });
  const target = Math.max(1, Math.floor(records.length / 3));
  const blendSelectionIndexes: number[] = [];
  if (ordered.length >= 3) {
    while (ordered.length > 2 && blendSelectionIndexes.length < target) {
      blendSelectionIndexes.push(...ordered.shift()![1]);
    }
  }
  const residualCalibrationIndexes: number[] = [];
  while (ordered.length > 1 && residualCalibrationIndexes.length < target) {
    residualCalibrationIndexes.push(...ordered.shift()![1]);
  }
  const confidenceCalibrationIndexes = ordered.flatMap(([, indexes]) => indexes);

  if (strategy === "temporal-group" && confidenceCalibrationIndexes.length > 0) {
    const confidenceCutoff = Math.min(
      ...confidenceCalibrationIndexes.map(
        (index) => soldRecordExactEventTimestamp(records[index]) ?? Number.POSITIVE_INFINITY,
      ),
    );
    const safeResidual = residualCalibrationIndexes.filter((index) => {
      const timestamp = soldRecordExactEventTimestamp(records[index]);
      return timestamp !== null && timestamp < confidenceCutoff;
    });
    const residualCutoff = Math.min(
      ...safeResidual.map(
        (index) => soldRecordExactEventTimestamp(records[index]) ?? Number.POSITIVE_INFINITY,
      ),
    );
    return {
      blendSelectionIndexes: blendSelectionIndexes.filter((index) => {
        const timestamp = soldRecordExactEventTimestamp(records[index]);
        return timestamp !== null && timestamp < residualCutoff;
      }),
      residualCalibrationIndexes: safeResidual,
      confidenceCalibrationIndexes,
    };
  }
  return {
    blendSelectionIndexes,
    residualCalibrationIndexes,
    confidenceCalibrationIndexes,
  };
}

function takeGroupHoldouts(
  orderedGroups: Array<[string, SoldRecord[]]>,
  sizes: ReturnType<typeof requestedHoldoutSizes>,
): RecordPartitions {
  const take = (target: number): SoldRecord[] => {
    const selected: SoldRecord[] = [];
    while (orderedGroups.length > 1 && selected.length < target) {
      selected.unshift(...orderedGroups.pop()![1]);
    }
    return selected;
  };

  const testRecords = take(sizes.test);
  const calibrationRecords = take(sizes.calibration);
  const stackerRecords = take(sizes.stacker);
  const validationRecords = take(sizes.validation);
  const trainingRecords = orderedGroups.flatMap(([, records]) => records);
  return {
    trainingRecords,
    validationRecords,
    stackerRecords,
    calibrationRecords,
    testRecords,
  };
}

function groupRandomPartitions(
  history: readonly SoldRecord[],
  sizes: ReturnType<typeof requestedHoldoutSizes>,
  seed: number,
): PartitionResult {
  const groups = groupedRecords(history);
  const orderedGroups = [...groups.entries()].sort((left, right) =>
    stableTieBreaker(left[0], seed).localeCompare(stableTieBreaker(right[0], seed)),
  );
  const partitions = takeGroupHoldouts(orderedGroups, sizes);
  if (
    partitions.trainingRecords.length === 0 ||
    partitions.validationRecords.length === 0 ||
    partitions.stackerRecords.length === 0
  ) {
    return {
      partitions: randomPartitions(history, sizes, seed),
      strategy: "random",
      excludedForUnknownEventTime: 0,
      excludedForTemporalOrdering: 0,
    };
  }
  return {
    partitions,
    strategy: "group-random",
    excludedForUnknownEventTime: 0,
    excludedForTemporalOrdering: 0,
  };
}

function temporalGroupPartitions(
  history: readonly SoldRecord[],
  sizes: ReturnType<typeof requestedHoldoutSizes>,
  seed: number,
): PartitionResult | null {
  const groups = groupedRecords(history);

  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const groupTimestamp = (records: readonly SoldRecord[]): number => {
      const timestamps = records.map(soldRecordExactEventTimestamp);
      // A family containing an uncertain event cannot safely enter a holdout.
      return timestamps.some((timestamp) => timestamp === null)
        ? Number.NEGATIVE_INFINITY
        : Math.min(...(timestamps as number[]));
    };
    const leftTimestamp = groupTimestamp(left[1]);
    const rightTimestamp = groupTimestamp(right[1]);
    if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
    return stableTieBreaker(left[0], seed).localeCompare(stableTieBreaker(right[0], seed));
  });
  const partitions = takeGroupHoldouts(orderedGroups, sizes);
  let excludedForUnknownEventTime = 0;
  let excludedForTemporalOrdering = 0;

  const exactTimes = (records: readonly SoldRecord[]): number[] =>
    records
      .map(soldRecordExactEventTimestamp)
      .filter((timestamp): timestamp is number => timestamp !== null);
  const filterStrictlyBefore = (
    records: readonly SoldRecord[],
    cutoff: number,
    allowObservedFallback: boolean,
  ): SoldRecord[] =>
    records.filter((record) => {
      const exact = soldRecordExactEventTimestamp(record);
      if (exact !== null) {
        const keep = exact < cutoff;
        if (!keep) excludedForTemporalOrdering++;
        return keep;
      }
      const keep = allowObservedFallback && soldRecordTimestamp(record) < cutoff;
      if (!keep) excludedForUnknownEventTime++;
      return keep;
    });

  // Process newest to oldest. A family is owned by only one cohort, while
  // crossing rows from that family are discarded instead of leaking future
  // outcomes into an earlier cohort.
  const testTimes = exactTimes(partitions.testRecords);
  if (sizes.test > 0 && testTimes.length !== partitions.testRecords.length) return null;
  let nextCutoff = testTimes.length > 0 ? Math.min(...testTimes) : Number.POSITIVE_INFINITY;

  if (partitions.calibrationRecords.length > 0 && Number.isFinite(nextCutoff)) {
    partitions.calibrationRecords = filterStrictlyBefore(
      partitions.calibrationRecords,
      nextCutoff,
      false,
    );
  }
  const calibrationTimes = exactTimes(partitions.calibrationRecords);
  if (
    sizes.calibration > 0 &&
    (partitions.calibrationRecords.length === 0 ||
      calibrationTimes.length !== partitions.calibrationRecords.length)
  ) {
    return null;
  }
  if (calibrationTimes.length > 0) nextCutoff = Math.min(...calibrationTimes);

  if (partitions.stackerRecords.length > 0 && Number.isFinite(nextCutoff)) {
    partitions.stackerRecords = filterStrictlyBefore(
      partitions.stackerRecords,
      nextCutoff,
      false,
    );
  }
  const stackerTimes = exactTimes(partitions.stackerRecords);
  if (
    sizes.stacker > 0 &&
    (partitions.stackerRecords.length === 0 ||
      stackerTimes.length !== partitions.stackerRecords.length)
  ) {
    return null;
  }
  if (stackerTimes.length > 0) nextCutoff = Math.min(...stackerTimes);

  if (partitions.validationRecords.length > 0 && Number.isFinite(nextCutoff)) {
    partitions.validationRecords = filterStrictlyBefore(
      partitions.validationRecords,
      nextCutoff,
      false,
    );
  }
  const validationTimes = exactTimes(partitions.validationRecords);
  if (
    partitions.validationRecords.length === 0 ||
    validationTimes.length !== partitions.validationRecords.length
  ) {
    return null;
  }
  nextCutoff = Math.min(...validationTimes);

  partitions.trainingRecords = filterStrictlyBefore(
    partitions.trainingRecords,
    nextCutoff,
    true,
  );

  if (
    partitions.trainingRecords.length === 0 ||
    partitions.validationRecords.length === 0 ||
    partitions.stackerRecords.length === 0
  ) {
    return null;
  }
  return {
    partitions,
    strategy: "temporal-group",
    excludedForUnknownEventTime,
    excludedForTemporalOrdering,
  };
}

function validateFractions(
  validationFraction: number,
  stackerFraction: number,
  calibrationFraction: number,
  testFraction: number,
): void {
  for (const [label, value] of [
    ["valFraction", validationFraction],
    ["stackerFraction", stackerFraction],
    ["calibrationFraction", calibrationFraction],
    ["testFraction", testFraction],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError(`${label} must be at least 0 and less than 1.`);
    }
  }
  if (validationFraction <= 0) throw new RangeError("valFraction must be greater than 0.");
  if (stackerFraction <= 0) throw new RangeError("stackerFraction must be greater than 0.");
  if (calibrationFraction <= 0) {
    throw new RangeError("calibrationFraction must be greater than 0 for independent calibration.");
  }
  if (testFraction <= 0) throw new RangeError("testFraction must be greater than 0.");
  if (validationFraction + stackerFraction + calibrationFraction + testFraction >= 0.8) {
    throw new RangeError("holdout fractions must leave at least 20% for training.");
  }
}

/** Returns a shuffled copy; the caller's history remains untouched. */
export function deterministicShuffle<T>(values: readonly T[], seed = DEFAULT_SPLIT_SEED): T[] {
  return sharedDeterministicShuffle(values, seed);
}

/**
 * Uses a cold-start temporal/group split by default, then derives every
 * normalization statistic from the training partition only.
 */
export function preparePriceTrainingData(
  history: readonly SoldRecord[],
  valFraction = 0.15,
  seed = DEFAULT_SPLIT_SEED,
  options: Pick<
    PriceTrainingOptions,
    "calibrationFraction" | "stackerFraction" | "testFraction" | "splitStrategy"
  > = {},
): PreparedPriceTrainingData {
  if (history.length < 2) {
    throw new RangeError("At least two records are required for a train/validation split.");
  }
  const calibrationFraction = options.calibrationFraction ?? DEFAULT_CALIBRATION_FRACTION;
  const stackerFraction = options.stackerFraction ?? DEFAULT_STACKER_FRACTION;
  const testFraction = options.testFraction ?? DEFAULT_TEST_FRACTION;
  validateFractions(valFraction, stackerFraction, calibrationFraction, testFraction);
  const splitStrategy = options.splitStrategy ?? "temporal-group";
  const sizes = requestedHoldoutSizes(
    history.length,
    valFraction,
    stackerFraction,
    calibrationFraction,
    testFraction,
  );
  const exactTimestampCount = history.filter(
    (record) => soldRecordExactEventTimestamp(record) !== null,
  ).length;
  const exactEventTimeCoverage = exactTimestampCount / history.length;
  const distinctExactTimestamps = new Set(
    history
      .map(soldRecordExactEventTimestamp)
      .filter((timestamp): timestamp is number => timestamp !== null),
  ).size;
  const temporalEligible =
    distinctExactTimestamps >= 4 &&
    (exactTimestampCount === history.length ||
      (exactTimestampCount >= 100 && exactEventTimeCoverage >= 0.8));
  let partitionResult: PartitionResult;
  if (splitStrategy === "random") {
    partitionResult = {
      partitions: randomPartitions(history, sizes, seed),
      strategy: "random",
      excludedForUnknownEventTime: 0,
      excludedForTemporalOrdering: 0,
    };
  } else if (temporalEligible) {
    partitionResult =
      temporalGroupPartitions(history, sizes, seed) ??
      groupRandomPartitions(history, sizes, seed);
  } else {
    partitionResult = groupRandomPartitions(history, sizes, seed);
  }
  const { partitions } = partitionResult;
  const appliedStrategy = partitionResult.strategy;

  const trainFeatureMatrix = partitions.trainingRecords.map((record) =>
    extractFeatures(record.username),
  );
  const featureMean: number[] = [];
  const featureStd: number[] = [];
  for (let feature = 0; feature < FEATURE_NAMES.length; feature++) {
    const column = trainFeatureMatrix.map((row) => row[feature]);
    const columnMean = mean(column);
    featureMean.push(columnMean);
    featureStd.push(std(column, columnMean));
  }
  const trainLogPrices = partitions.trainingRecords.map((record) => Math.log1p(record.priceTon));
  const targetMean = mean(trainLogPrices);
  const targetStd = std(trainLogPrices, targetMean);

  const normalized = (records: readonly SoldRecord[]): { inputs: number[][]; targets: number[][] } => {
    const inputs = records.map((record) => {
      const features = extractFeatures(record.username);
      if (
        features.length !== FEATURE_NAMES.length ||
        features.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(`Invalid feature vector for @${record.username}.`);
      }
      return features.map((value, index) => (value - featureMean[index]) / featureStd[index]);
    });
    const targets = records.map((record) => [
      (Math.log1p(record.priceTon) - targetMean) / targetStd,
    ]);
    return { inputs, targets };
  };

  const train = normalized(partitions.trainingRecords);
  const validation = normalized(partitions.validationRecords);
  const stacker = normalized(partitions.stackerRecords);
  const calibration = normalized(partitions.calibrationRecords);
  const test = normalized(partitions.testRecords);
  return {
    trainInputs: train.inputs,
    trainTargets: train.targets,
    trainWeights: partitions.trainingRecords.map(soldRecordTrainingWeight),
    validationInputs: validation.inputs,
    validationTargets: validation.targets,
    stackerInputs: stacker.inputs,
    stackerTargets: stacker.targets,
    calibrationInputs: calibration.inputs,
    calibrationTargets: calibration.targets,
    testInputs: test.inputs,
    testTargets: test.targets,
    ...partitions,
    featureMean,
    featureStd,
    targetMean,
    targetStd,
    split: {
      strategy: appliedStrategy,
      requestedStrategy: splitStrategy,
      groupKeyVersion: 2,
      exactEventTimeCoverage,
      excludedForUnknownEventTime: partitionResult.excludedForUnknownEventTime,
      excludedForTemporalOrdering: partitionResult.excludedForTemporalOrdering,
      validationFraction: valFraction,
      stackerFraction,
      calibrationFraction,
      testFraction,
      trainingThrough: latestIso(partitions.trainingRecords),
      validationThrough: latestIso(partitions.validationRecords),
      stackerThrough: latestIso(partitions.stackerRecords),
      calibrationThrough: latestIso(partitions.calibrationRecords),
      testThrough: latestIso(partitions.testRecords),
    },
  };
}

function mse(
  mlp: MLP,
  inputs: readonly number[][],
  targets: readonly number[][],
  sampleWeights?: readonly number[],
): number {
  if (inputs.length === 0) return Number.NaN;
  if (targets.length !== inputs.length || (sampleWeights && sampleWeights.length !== inputs.length)) {
    throw new RangeError("MSE inputs, targets and sample weights must have equal lengths.");
  }
  const weights = sampleWeights ?? new Array<number>(inputs.length).fill(1);
  const totalWeight = weights.reduce((sum, weight) => {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RangeError("MSE sample weights must be positive finite numbers.");
    }
    return sum + weight;
  }, 0);
  return inputs.reduce((sum, input, index) => {
    const delta = mlp.predict(input)[0] - targets[index][0];
    return sum + weights[index] * delta * delta;
  }, 0) / totalWeight;
}

function cloneMlpJson(json: MLPJSON): MLPJSON {
  return {
    config: { ...json.config, hiddenSizes: [...json.config.hiddenSizes] },
    layers: json.layers.map((layer) => ({
      W: layer.W.map((row) => [...row]),
      b: [...layer.b],
    })),
  };
}

interface FittedMember {
  json: MLPJSON;
  bestEpoch: number;
  trainMse: number;
  validationMse: number;
}

function fitMember(
  data: PreparedPriceTrainingData,
  opts: Required<
    Pick<
      PriceTrainingOptions,
      | "epochs"
      | "batchSize"
      | "learningRate"
      | "hiddenSizes"
      | "earlyStoppingRounds"
    >
  >,
  seed: number,
  memberIndex: number,
): FittedMember {
  const mlp = new MLP({
    inputSize: FEATURE_NAMES.length,
    hiddenSizes: opts.hiddenSizes,
    outputSize: 1,
    outputActivation: "linear",
    seed,
  });
  let bestCheckpoint: MLPJSON | null = null;
  let bestEpoch = -1;
  let bestTrainMse = Number.POSITIVE_INFINITY;
  let bestValidationMse = Number.POSITIVE_INFINITY;
  let epochsWithoutImprovement = 0;

  mlp.train(data.trainInputs, data.trainTargets, {
    epochs: opts.epochs,
    batchSize: opts.batchSize,
    learningRate: opts.learningRate,
    sampleWeights: data.trainWeights,
    onEpoch: (epoch) => {
      const trainMse = mse(mlp, data.trainInputs, data.trainTargets, data.trainWeights);
      const validationMse = mse(
        mlp,
        data.validationInputs,
        data.validationTargets,
        data.validationRecords.map(soldRecordTrainingWeight),
      );
      if (!Number.isFinite(trainMse) || !Number.isFinite(validationMse)) {
        throw new Error("Price-model training became numerically unstable.");
      }
      if (validationMse < bestValidationMse) {
        bestCheckpoint = cloneMlpJson(mlp.toJSON());
        bestEpoch = epoch;
        bestTrainMse = trainMse;
        bestValidationMse = validationMse;
        epochsWithoutImprovement = 0;
      } else {
        epochsWithoutImprovement++;
      }
      if (
        memberIndex === 0 &&
        (epoch % 20 === 0 || epoch === opts.epochs - 1)
      ) {
        console.log(
          `Epoch ${epoch}: train MSE=${trainMse.toFixed(4)}, val MSE=${validationMse.toFixed(4)}`,
        );
      }
      return epochsWithoutImprovement >= opts.earlyStoppingRounds;
    },
  });
  if (!bestCheckpoint || bestEpoch < 0) {
    throw new Error("Could not obtain a valid price-model checkpoint.");
  }
  return {
    json: bestCheckpoint,
    bestEpoch,
    trainMse: bestTrainMse,
    validationMse: bestValidationMse,
  };
}

interface NormalizedRegressor {
  predict(input: number[]): number[];
}

function medianNormalizedPrediction(
  models: readonly NormalizedRegressor[],
  input: number[],
): number {
  return quantile(
    models.map((model) => model.predict(input)[0]),
    0.5,
  );
}

function gbtRegressor(model: GradientBoostedTrees): NormalizedRegressor {
  return { predict: (input) => [model.predict(input)] };
}

function stackFeatureVector(
  models: readonly NormalizedRegressor[],
  input: number[],
): number[] {
  return models.map((model) => model.predict(input)[0]);
}

function stackedNormalizedPrediction(
  models: readonly NormalizedRegressor[],
  stacker: RidgeModel | null,
  input: number[],
): number {
  return stacker
    ? stacker.predict(stackFeatureVector(models, input))[0]
    : medianNormalizedPrediction(models, input);
}

function ensembleMse(
  models: readonly NormalizedRegressor[],
  stacker: RidgeModel | null,
  inputs: readonly number[][],
  targets: readonly number[][],
  sampleWeights?: readonly number[],
): number {
  if (inputs.length === 0) return Number.NaN;
  if (targets.length !== inputs.length || (sampleWeights && sampleWeights.length !== inputs.length)) {
    throw new RangeError("Ensemble MSE inputs, targets and sample weights must have equal lengths.");
  }
  const weights = sampleWeights ?? new Array<number>(inputs.length).fill(1);
  const totalWeight = weights.reduce((sum, weight) => {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RangeError("Ensemble MSE sample weights must be positive finite numbers.");
    }
    return sum + weight;
  }, 0);
  return inputs.reduce((sum, input, index) => {
    const delta = stackedNormalizedPrediction(models, stacker, input) - targets[index][0];
    return sum + weights[index] * delta * delta;
  }, 0) / totalWeight;
}

export function selectPriceCalibrationBin(
  calibration: PriceModelCalibration,
  predictedLog: number,
): Pick<
  PriceModelCalibration,
  "residualP10Log" | "residualP50Log" | "residualP90Log" | "sampleSize"
> {
  const bin = calibration.bins?.find(
    (candidate) => predictedLog <= candidate.maxPredictedLog,
  ) ?? calibration.bins?.at(-1);
  return bin ?? calibration;
}

function finiteSampleResidualQuantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new RangeError("Residual calibration requires observations.");
  const ordered = [...values].sort((left, right) => left - right);
  const rawRank =
    probability < 0.5
      ? Math.floor((ordered.length + 1) * probability)
      : Math.ceil((ordered.length + 1) * probability);
  const rank = Math.max(1, Math.min(ordered.length, rawRank));
  return ordered[rank - 1];
}

/** Partitions sorted rows without ever splitting equal score values. */
function tieAwarePartitions<T>(
  ordered: readonly T[],
  score: (row: T) => number,
  requestedBins: number,
): T[][] {
  if (ordered.length === 0) return [];
  const tiedGroups: T[][] = [];
  for (const row of ordered) {
    const previous = tiedGroups.at(-1);
    if (previous && score(previous[0]) === score(row)) previous.push(row);
    else tiedGroups.push([row]);
  }
  const binCount = Math.min(Math.max(1, requestedBins), tiedGroups.length);
  if (binCount === 1) return [[...ordered]];

  const result: T[][] = [];
  let current: T[] = [];
  let consumed = 0;
  for (let groupIndex = 0; groupIndex < tiedGroups.length; groupIndex++) {
    const group = tiedGroups[groupIndex];
    current.push(...group);
    const binsStillNeeded = binCount - result.length;
    const rowsRemaining = ordered.length - consumed;
    const targetSize = Math.ceil(rowsRemaining / binsStillNeeded);
    consumed += group.length;
    const groupsRemaining = tiedGroups.length - groupIndex - 1;
    if (
      result.length < binCount - 1 &&
      current.length >= targetSize &&
      groupsRemaining >= binCount - result.length - 1
    ) {
      result.push(current);
      current = [];
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

export function buildResidualCalibration(
  predictedLogs: readonly number[],
  actualLogs: readonly number[],
): PriceModelCalibration {
  if (
    predictedLogs.length === 0 ||
    predictedLogs.length !== actualLogs.length ||
    predictedLogs.some((value) => !Number.isFinite(value)) ||
    actualLogs.some((value) => !Number.isFinite(value))
  ) {
    throw new RangeError("Residual calibration inputs must be finite, aligned and non-empty.");
  }
  const residuals = predictedLogs.map(
    (predicted, index) => actualLogs[index] - predicted,
  );
  const globalP50 = quantile(residuals, 0.5);
  const desiredBins = Math.min(4, Math.floor(residuals.length / 100));
  const bins: PriceModelCalibrationBin[] = [];
  if (desiredBins >= 2) {
    const ordered = predictedLogs
      .map((predictedLog, index) => ({
        predictedLog,
        residual: residuals[index],
      }))
      .sort(
        (left, right) =>
          left.predictedLog - right.predictedLog || left.residual - right.residual,
      );
    const partitions = tieAwarePartitions(
      ordered,
      (row) => row.predictedLog,
      desiredBins,
    );
    for (const rows of partitions.length >= 2 ? partitions : []) {
      const binResiduals = rows.map(({ residual }) => residual);
      bins.push({
        maxPredictedLog: rows.at(-1)!.predictedLog,
        residualP10Log: Math.min(
          finiteSampleResidualQuantile(binResiduals, 0.1),
          globalP50,
        ),
        // A single median preserves global ranking and tail RMSLE. Mondrian
        // bins model heteroscedastic interval width only.
        residualP50Log: globalP50,
        residualP90Log: Math.max(
          finiteSampleResidualQuantile(binResiduals, 0.9),
          globalP50,
        ),
        sampleSize: binResiduals.length,
      });
    }
  }
  return {
    residualP10Log: Math.min(finiteSampleResidualQuantile(residuals, 0.1), globalP50),
    residualP50Log: globalP50,
    residualP90Log: Math.max(finiteSampleResidualQuantile(residuals, 0.9), globalP50),
    sampleSize: residuals.length,
    nominalCoverage: 0.8,
    ...(bins.length > 0 ? { bins } : {}),
  };
}

export function rawPriceConfidenceScore(
  oodScore: number,
  disagreementLog: number,
  calibrationSampleSize: number,
): number {
  const disagreementPenalty = Math.max(
    0,
    Math.min(1, disagreementLog / Math.log(3)),
  );
  const calibrationPenalty =
    calibrationSampleSize >= 100
      ? 0
      : (1 - Math.max(0, calibrationSampleSize) / 100) * 0.2;
  return Math.max(
    0,
    Math.min(
      1,
      1 - Math.max(0, Math.min(1, oodScore)) * 0.55 -
        disagreementPenalty * 0.25 -
        calibrationPenalty,
    ),
  );
}

export function applyPriceConfidenceCalibration(
  calibration: PriceConfidenceCalibration | undefined,
  rawScore: number,
): number {
  if (!calibration?.bins.length) return Math.max(0, Math.min(1, rawScore));
  const bin =
    calibration.bins.find((candidate) => rawScore <= candidate.maxRawScore) ??
    calibration.bins.at(-1)!;
  return bin.probabilityWithin2x;
}

export function buildConfidenceCalibration(
  rawScores: readonly number[],
  actual: readonly number[],
  predicted: readonly number[],
): PriceConfidenceCalibration | undefined {
  if (rawScores.length < 80 || rawScores.length !== actual.length) return undefined;
  const desiredBins = Math.min(6, Math.max(2, Math.floor(rawScores.length / 100)));
  const ordered = rawScores
    .map((rawScore, index) => ({
      rawScore,
      success: isWithinPriceFactor(actual[index], predicted[index], 2) ? 1 : 0,
    }))
    .sort((left, right) => left.rawScore - right.rawScore);
  const blocks: Array<{
    maxRawScore: number;
    sampleSize: number;
    successes: number;
  }> = [];
  const partitions = tieAwarePartitions(ordered, (row) => row.rawScore, desiredBins);
  for (const rows of partitions) {
    blocks.push({
      maxRawScore: rows.at(-1)!.rawScore,
      sampleSize: rows.length,
      successes: rows.reduce((sum, row) => sum + row.success, 0),
    });
  }
  // Pool-adjacent-violators makes higher raw confidence monotonically no worse.
  for (let index = 1; index < blocks.length; ) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    if (
      previous.successes / previous.sampleSize <=
      current.successes / current.sampleSize
    ) {
      index++;
      continue;
    }
    previous.maxRawScore = current.maxRawScore;
    previous.sampleSize += current.sampleSize;
    previous.successes += current.successes;
    blocks.splice(index, 1);
    if (index > 1) index--;
  }
  return {
    definition: "within-2x",
    sampleSize: rawScores.length,
    bins: blocks.map((block) => ({
      maxRawScore: block.maxRawScore,
      probabilityWithin2x: block.successes / block.sampleSize,
      sampleSize: block.sampleSize,
    })),
  };
}

export function priceHistoryDataHash(history: readonly SoldRecord[]): string {
  const canonical = history
    .map((record) => ({
      eventId: (record as SoldRecord & { eventId?: string }).eventId ?? "",
      username: record.username.toLowerCase(),
      priceTon: record.priceTon,
      eventAt: soldRecordTimestamp(record),
      scrapedAt: record.scrapedAt,
      saleAt: record.saleAt ?? "",
      confidence: record.confidence ?? "",
      parser: record.provenance?.parser ?? "",
    }))
    .sort((left, right) =>
      `${left.eventAt}:${left.eventId}:${left.username}:${left.priceTon}`.localeCompare(
        `${right.eventAt}:${right.eventId}:${right.username}:${right.priceTon}`,
      ),
    );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function comparablePipelineHash(): string {
  return createHash("sha256").update(COMPARABLE_PIPELINE_SIGNATURE).digest("hex");
}

function featureSchemaHash(): string {
  return createHash("sha256").update(FEATURE_NAMES.join("\n")).digest("hex");
}

function structuralSegment(username: string): string {
  return [
    username.length,
    /\d/.test(username) ? "digits" : "no-digits",
    username.includes("_") ? "underscore" : "no-underscore",
  ].join(":");
}

function baselinePredictions(
  data: PreparedPriceTrainingData,
  targets: readonly SoldRecord[] = data.testRecords,
  reference: readonly SoldRecord[] = [
    ...data.trainingRecords,
    ...data.validationRecords,
    ...data.stackerRecords,
    ...data.calibrationRecords,
  ],
): {
  globalMedian: number[];
  structuralMedian: number[];
  comparables: number[];
  comparableP10: number[];
  comparableP90: number[];
  comparableConfidence: number[];
} {
  const globalMedian: number[] = [];
  const structuralMedian: number[] = [];
  const comparables: number[] = [];
  const comparableP10: number[] = [];
  const comparableP90: number[] = [];
  const comparableConfidence: number[] = [];

  for (const target of targets) {
    const valuationAt = soldRecordTimestamp(target);
    const eligible = reference.filter(
      (record) => soldRecordTimestamp(record) < valuationAt,
    );
    const fallbackPool = eligible.length > 0 ? eligible : data.trainingRecords;
    const fallback = quantile(
      fallbackPool.map((record) => record.priceTon),
      0.5,
    );
    globalMedian.push(fallback);

    const targetSegment = structuralSegment(target.username);
    const segmentPool = fallbackPool.filter(
      (record) => structuralSegment(record.username) === targetSegment,
    );
    const segmentMedian =
      segmentPool.length >= 3
        ? quantile(
            segmentPool.map((record) => record.priceTon),
            0.5,
          )
        : fallback;
    structuralMedian.push(segmentMedian);

    const eventId = (target as SoldRecord & { eventId?: string }).eventId;
    const estimate = estimateProductionComparablePrice(
      target.username,
      reference,
      valuationAt,
      eventId ? { excludeEventId: eventId } : {},
    );
    const usable = estimate.p50Ton > 0;
    comparables.push(usable ? estimate.p50Ton : segmentMedian);
    comparableP10.push(usable ? estimate.p10Ton : segmentMedian);
    comparableP90.push(usable ? estimate.p90Ton : segmentMedian);
    comparableConfidence.push(usable ? estimate.confidence : 0);
  }
  return {
    globalMedian,
    structuralMedian,
    comparables,
    comparableP10,
    comparableP90,
    comparableConfidence,
  };
}

function blendComparablePredictions(
  modelPredictions: readonly number[],
  comparablePredictions: readonly number[],
  comparableConfidence: readonly number[],
  scale: number,
): number[] {
  return modelPredictions.map((modelPrice, index) => {
    const comparablePrice = comparablePredictions[index];
    if (!(comparablePrice > 0) || !(scale > 0)) return modelPrice;
    const weight = comparableBlendWeight(comparableConfidence[index], scale);
    return priceFromLog(
      Math.log1p(modelPrice) * (1 - weight) +
        Math.log1p(comparablePrice) * weight,
    );
  });
}

export function comparableBlendWeight(confidence: number, scale: number): number {
  return Math.min(Math.max(0, scale), Math.max(0, confidence) * Math.max(0, scale));
}

export function combinedRawPriceConfidence(
  baseScore: number,
  modelPrice: number,
  comparablePrice: number,
  comparableConfidence: number,
  scale: number,
): number {
  const weight = comparableBlendWeight(comparableConfidence, scale);
  if (!(comparablePrice > 0) || !(weight > 0)) return Math.max(0, Math.min(1, baseScore));
  const disagreement = Math.abs(Math.log1p(modelPrice) - Math.log1p(comparablePrice));
  return Math.max(
    0,
    Math.min(
      1,
      baseScore * (1 - weight) +
        comparableConfidence * weight -
        Math.min(1, disagreement / Math.log(10)) * 0.1,
    ),
  );
}

function evaluateTestSlices(
  records: readonly SoldRecord[],
  actual: readonly number[],
  predicted: readonly number[],
): Record<string, PriceAccuracyMetrics> {
  const definitions: Array<[string, (record: SoldRecord) => boolean]> = [
    ["floor_le_10", (record) => record.priceTon <= 10],
    ["ordinary_10_100", (record) => record.priceTon > 10 && record.priceTon <= 100],
    ["mid_100_1000", (record) => record.priceTon > 100 && record.priceTon <= 1_000],
    ["high_gt_1000", (record) => record.priceTon > 1_000],
    ["len_4", (record) => record.username.length === 4],
    ["len_5", (record) => record.username.length === 5],
    ["has_digits", (record) => /\d/.test(record.username)],
    ["has_underscore", (record) => record.username.includes("_")],
  ];
  const output: Record<string, PriceAccuracyMetrics> = {};
  for (const [name, predicate] of definitions) {
    const indexes = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => predicate(record))
      .map(({ index }) => index);
    if (indexes.length === 0) continue;
    output[name] = evaluatePricePredictions(
      indexes.map((index) => actual[index]),
      indexes.map((index) => predicted[index]),
    );
  }
  return output;
}

/**
 * Pure in-memory training entry point. Network selection uses validation,
 * residual intervals use a separate calibration cohort, and final metrics use
 * an untouched temporal test cohort.
 */
export function fitPriceModel(
  history: readonly SoldRecord[],
  opts: PriceTrainingOptions = {},
): PriceModelFile {
  const epochs = opts.epochs ?? 100;
  const batchSize = opts.batchSize ?? 64;
  const learningRate = opts.learningRate ?? 0.003;
  const hiddenSizes = opts.hiddenSizes ?? [32, 16];
  const ensembleSize = opts.ensembleSize ?? 3;
  const ridgeLambda = opts.ridgeLambda ?? 8;
  const gbtTrees = opts.gbtTrees ?? 300;
  const gbtMaxDepth = opts.gbtMaxDepth ?? 4;
  const stackerLambda = opts.stackerLambda ?? 0.1;
  const earlyStoppingRounds = opts.earlyStoppingRounds ?? 15;
  if (!Number.isSafeInteger(epochs) || epochs <= 0) {
    throw new RangeError("epochs must be a positive integer.");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer.");
  }
  if (!Number.isFinite(learningRate) || learningRate <= 0) {
    throw new RangeError("learningRate must be a positive finite number.");
  }
  if (!Number.isSafeInteger(ensembleSize) || ensembleSize < 1 || ensembleSize > 9) {
    throw new RangeError("ensembleSize must be an integer from 1 to 9.");
  }
  if (!Number.isFinite(ridgeLambda) || ridgeLambda <= 0) {
    throw new RangeError("ridgeLambda must be a positive finite number.");
  }
  if (!Number.isSafeInteger(gbtTrees) || gbtTrees < 1 || gbtTrees > 2_000) {
    throw new RangeError("gbtTrees must be an integer from 1 to 2000.");
  }
  if (!Number.isSafeInteger(gbtMaxDepth) || gbtMaxDepth < 1 || gbtMaxDepth > 8) {
    throw new RangeError("gbtMaxDepth must be an integer from 1 to 8.");
  }
  if (!Number.isFinite(stackerLambda) || stackerLambda <= 0) {
    throw new RangeError("stackerLambda must be a positive finite number.");
  }
  if (
    !Number.isSafeInteger(earlyStoppingRounds) ||
    earlyStoppingRounds < 1 ||
    earlyStoppingRounds > epochs
  ) {
    throw new RangeError("earlyStoppingRounds must be an integer from 1 to epochs.");
  }

  const seed = opts.seed ?? DEFAULT_SPLIT_SEED;
  const data = preparePriceTrainingData(history, opts.valFraction ?? 0.15, seed, opts);
  const members = Array.from({ length: ensembleSize }, (_, index) =>
    fitMember(
      data,
      { epochs, batchSize, learningRate, hiddenSizes, earlyStoppingRounds },
      seed + index * 104_729,
      index,
    ),
  );
  const networkModels = members.map((member) => MLP.fromJSON(member.json));
  const ridge = RidgeModel.fit(
    data.trainInputs,
    data.trainTargets.map(([target]) => target),
    {
      lambda: ridgeLambda,
      robustIterations: 2,
      huberDelta: 1.5,
      sampleWeights: data.trainWeights,
    },
  );
  const gbt = GradientBoostedTrees.fit(
    data.trainInputs,
    data.trainTargets.map(([target]) => target),
    {
      trees: gbtTrees,
      learningRate: 0.04,
      maxDepth: gbtMaxDepth,
      minLeaf: Math.max(2, Math.min(20, Math.floor(data.trainInputs.length / 20))),
      rowSubsample: 0.9,
      featureSubsample: 0.8,
      maxBins: 64,
      seed: seed ^ 0x4f1bbcdc,
      sampleWeights: data.trainWeights,
      validation: {
        inputs: data.validationInputs,
        targets: data.validationTargets.map(([target]) => target),
        sampleWeights: data.validationRecords.map(soldRecordTrainingWeight),
      },
      earlyStoppingRounds: Math.min(30, gbtTrees),
      minImprovement: 1e-6,
    },
  );
  const tailThresholds = [100, 1_000, 10_000] as const;
  const tailClassifiers = tailThresholds.map((thresholdTon) => ({
    thresholdTon,
    model: RidgeModel.fit(
      data.trainInputs,
      data.trainingRecords.map((record) => (record.priceTon > thresholdTon ? 1 : 0)),
      {
        lambda: 32,
        robustIterations: 0,
        sampleWeights: data.trainWeights,
      },
    ),
  }));
  const priceModels: NormalizedRegressor[] = [
    ...networkModels,
    ridge,
    gbtRegressor(gbt),
  ];
  const stackModels: NormalizedRegressor[] = [
    ...priceModels,
    ...tailClassifiers.map(({ model }) => model),
  ];
  const stackFeatureNames = [
    ...networkModels.map((_, index) => `mlp_${index}`),
    "ridge_log_price",
    "gbt_log_price",
    ...tailClassifiers.map(({ thresholdTon }) => `ridge_tail_gt_${thresholdTon}`),
  ];
  const stacker = RidgeModel.fit(
    data.stackerInputs.map((input) => stackFeatureVector(stackModels, input)),
    data.stackerTargets.map(([target]) => target),
    {
      lambda: stackerLambda,
      robustIterations: 0,
      sampleWeights: data.stackerRecords.map(soldRecordTrainingWeight),
    },
  );
  const primary = [...members].sort((left, right) => left.validationMse - right.validationMse)[0];

  if (data.calibrationRecords.length === 0) {
    throw new RangeError("An independent calibration cohort is required.");
  }
  const calibrationSubsets = splitIndependentCalibrationCohorts(
    data.calibrationRecords,
    data.split.strategy,
    seed,
  );
  const blendSelectionRecords = calibrationSubsets.blendSelectionIndexes.map(
    (index) => data.calibrationRecords[index],
  );
  const blendSelectionInputs = calibrationSubsets.blendSelectionIndexes.map(
    (index) => data.calibrationInputs[index],
  );
  const residualCalibrationRecords = calibrationSubsets.residualCalibrationIndexes.map(
    (index) => data.calibrationRecords[index],
  );
  const residualCalibrationInputs = calibrationSubsets.residualCalibrationIndexes.map(
    (index) => data.calibrationInputs[index],
  );
  const confidenceCalibrationRecords = calibrationSubsets.confidenceCalibrationIndexes.map(
    (index) => data.calibrationRecords[index],
  );
  const confidenceCalibrationInputs = calibrationSubsets.confidenceCalibrationIndexes.map(
    (index) => data.calibrationInputs[index],
  );
  const usedCalibrationIndexes = new Set([
    ...calibrationSubsets.blendSelectionIndexes,
    ...calibrationSubsets.residualCalibrationIndexes,
    ...calibrationSubsets.confidenceCalibrationIndexes,
  ]);
  if (residualCalibrationRecords.length === 0) {
    throw new RangeError("The independent residual-calibration cohort is empty.");
  }

  const predictedBaseLog = (input: number[]): number =>
    stackedNormalizedPrediction(stackModels, stacker, input) * data.targetStd +
    data.targetMean;
  const blendSelectionModelPrices = blendSelectionInputs.map((input) =>
    priceFromLog(predictedBaseLog(input)),
  );
  const blendSelectionComparable = baselinePredictions(
    data,
    blendSelectionRecords,
    [...data.trainingRecords, ...data.validationRecords, ...data.stackerRecords],
  );
  const blendCandidates = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65] as const;
  let comparableBlendScale = 0;
  let bestBlendRmsle = Number.POSITIVE_INFINITY;
  if (blendSelectionRecords.length > 0) {
    for (const scale of blendCandidates) {
      const predictions = blendComparablePredictions(
        blendSelectionModelPrices,
        blendSelectionComparable.comparables,
        blendSelectionComparable.comparableConfidence,
        scale,
      );
      const metric = evaluatePricePredictions(
        blendSelectionRecords.map((record) => record.priceTon),
        predictions,
      );
      if (metric.rmsle < bestBlendRmsle - 1e-9) {
        bestBlendRmsle = metric.rmsle;
        comparableBlendScale = scale;
      }
    }
  }

  const trainDistances = data.trainInputs.map((input) =>
    Math.sqrt(input.reduce((sum, value) => sum + value * value, 0) / input.length),
  );
  const oodCalibration: PriceModelOodCalibration = {
    distanceP50: quantile(trainDistances, 0.5),
    distanceP90: quantile(trainDistances, 0.9),
    distanceP99: quantile(trainDistances, 0.99),
  };
  const residualCalibrationModelPrices = residualCalibrationInputs.map((input) =>
    priceFromLog(predictedBaseLog(input)),
  );
  const residualCalibrationComparable = baselinePredictions(
    data,
    residualCalibrationRecords,
    [
      ...data.trainingRecords,
      ...data.validationRecords,
      ...data.stackerRecords,
      ...blendSelectionRecords,
    ],
  );
  const residualCalibrationBasePrices = blendComparablePredictions(
    residualCalibrationModelPrices,
    residualCalibrationComparable.comparables,
    residualCalibrationComparable.comparableConfidence,
    comparableBlendScale,
  );
  const residualCalibrationBaseLogs = residualCalibrationBasePrices.map((price) =>
    Math.log1p(price),
  );
  const calibration = buildResidualCalibration(
    residualCalibrationBaseLogs,
    residualCalibrationRecords.map((record) => Math.log1p(record.priceTon)),
  );
  // Confidence is calibrated only after the point predictor and residual
  // correction are frozen on earlier, disjoint cohorts.
  const confidenceCalibrationModelPrices = confidenceCalibrationInputs.map((input) =>
    priceFromLog(predictedBaseLog(input)),
  );
  const confidenceCalibrationComparable = baselinePredictions(
    data,
    confidenceCalibrationRecords,
    [
      ...data.trainingRecords,
      ...data.validationRecords,
      ...data.stackerRecords,
      ...blendSelectionRecords,
      ...residualCalibrationRecords,
    ],
  );
  const confidenceCalibrationBasePrices = blendComparablePredictions(
    confidenceCalibrationModelPrices,
    confidenceCalibrationComparable.comparables,
    confidenceCalibrationComparable.comparableConfidence,
    comparableBlendScale,
  );
  const confidenceCalibrationBaseLogs = confidenceCalibrationBasePrices.map((price) =>
    Math.log1p(price),
  );
  const confidenceCalibrationPredictions = confidenceCalibrationBaseLogs.map((baseLog) => {
    const selected = selectPriceCalibrationBin(calibration, baseLog);
    return priceFromLog(baseLog + selected.residualP50Log);
  });
  const calibrationRawConfidence = confidenceCalibrationInputs.map((input, index) => {
    const featureDistance = Math.sqrt(
      input.reduce((sum, value) => sum + value * value, 0) / input.length,
    );
    const oodScore = Math.max(
      0,
      Math.min(
        1,
        (featureDistance - oodCalibration.distanceP90) /
          Math.max(
            oodCalibration.distanceP99 - oodCalibration.distanceP90,
            1e-9,
          ),
      ),
    );
    const disagreementLog =
      standardDeviation(priceModels.map((model) => model.predict(input)[0])) *
      data.targetStd;
    const score = rawPriceConfidenceScore(
      oodScore,
      disagreementLog,
      selectPriceCalibrationBin(
        calibration,
        confidenceCalibrationBaseLogs[index],
      ).sampleSize,
    );
    return combinedRawPriceConfidence(
      score,
      confidenceCalibrationModelPrices[index],
      confidenceCalibrationComparable.comparables[index],
      confidenceCalibrationComparable.comparableConfidence[index],
      comparableBlendScale,
    );
  });
  const confidenceCalibration = buildConfidenceCalibration(
    calibrationRawConfidence,
    confidenceCalibrationRecords.map((record) => record.priceTon),
    confidenceCalibrationPredictions,
  );

  let test: PriceAccuracyMetrics | undefined;
  let testModelOnly: PriceAccuracyMetrics | undefined;
  let testInterval: PriceIntervalMetrics | undefined;
  let baselines: PriceModelMetrics["baselines"];
  let testTopTail: PriceRankingMetrics | undefined;
  let baselineTopTail: PriceModelMetrics["baselineTopTail"];
  let testSlices: Record<string, PriceAccuracyMetrics> | undefined;
  if (data.testInputs.length > 0) {
    const actual = data.testRecords.map((record) => record.priceTon);
    const modelBaseLogs = data.testInputs.map(predictedBaseLog);
    const modelBasePrices = modelBaseLogs.map(priceFromLog);
    const baselineValues = baselinePredictions(data);
    const finalBasePrices = blendComparablePredictions(
      modelBasePrices,
      baselineValues.comparables,
      baselineValues.comparableConfidence,
      comparableBlendScale,
    );
    const finalBaseLogs = finalBasePrices.map((price) => Math.log1p(price));
    const testLogIntervals = data.testInputs.map((input, index) => {
      const finalBaseLog = finalBaseLogs[index];
      const selected = selectPriceCalibrationBin(calibration, finalBaseLog);
      const featureDistance = Math.sqrt(
        input.reduce((sum, value) => sum + value * value, 0) / input.length,
      );
      const oodScore = Math.max(
        0,
        Math.min(
          1,
          (featureDistance - oodCalibration.distanceP90) /
            Math.max(
              oodCalibration.distanceP99 - oodCalibration.distanceP90,
              1e-9,
            ),
        ),
      );
      const disagreementLog =
        standardDeviation(priceModels.map((model) => model.predict(input)[0])) *
        data.targetStd;
      const retrievalDisagreementLog =
        comparableBlendWeight(
          baselineValues.comparableConfidence[index],
          comparableBlendScale,
        ) > 0
          ? Math.abs(
              Math.log1p(modelBasePrices[index]) -
                Math.log1p(baselineValues.comparables[index]),
            ) * 0.2
          : 0;
      const extraWidthLog =
        oodScore *
          (disagreementLog * PRICE_DISAGREEMENT_OOD_INTERVAL_FACTOR +
            PRICE_OOD_INTERVAL_LOG_WIDTH) +
        retrievalDisagreementLog;
      return {
        median: finalBaseLog + selected.residualP50Log,
        lower: finalBaseLog + selected.residualP10Log - extraWidthLog,
        upper: finalBaseLog + selected.residualP90Log + extraWidthLog,
      };
    });
    const modelPredicted = modelBaseLogs.map((baseLog) =>
      priceFromLog(baseLog + calibration.residualP50Log),
    );
    const predicted = testLogIntervals.map(({ median }) => priceFromLog(median));
    const lower = testLogIntervals.map(({ lower: value }) => priceFromLog(value));
    const upper = testLogIntervals.map(({ upper: value }) => priceFromLog(value));
    test = evaluatePricePredictions(actual, predicted);
    testModelOnly = evaluatePricePredictions(actual, modelPredicted);
    testInterval = evaluatePriceIntervals(actual, lower, upper);
    testTopTail = evaluateTopTailRecall(actual, predicted, 0.05);
    testSlices = evaluateTestSlices(data.testRecords, actual, predicted);
    baselines = {
      globalMedian: evaluatePricePredictions(actual, baselineValues.globalMedian),
      structuralMedian: evaluatePricePredictions(actual, baselineValues.structuralMedian),
      comparables: evaluatePricePredictions(actual, baselineValues.comparables),
    };
    baselineTopTail = {
      globalMedian: evaluateTopTailRecall(actual, baselineValues.globalMedian, 0.05),
      structuralMedian: evaluateTopTailRecall(
        actual,
        baselineValues.structuralMedian,
        0.05,
      ),
      comparables: evaluateTopTailRecall(actual, baselineValues.comparables, 0.05),
    };
  }

  const baselineEntries = baselines
    ? (Object.entries(baselines) as Array<
        [
          "globalMedian" | "structuralMedian" | "comparables",
          PriceAccuracyMetrics,
        ]
      >)
    : [];
  const bestBaselineEntry = baselineEntries.sort(
    (left, right) => left[1].rmsle - right[1].rmsle,
  )[0];
  const rmsleImprovement =
    test && bestBaselineEntry && bestBaselineEntry[1].rmsle > 0
      ? (bestBaselineEntry[1].rmsle - test.rmsle) / bestBaselineEntry[1].rmsle
      : 0;
  const bestBaselineTailRecall = baselineTopTail
    ? Math.max(...Object.values(baselineTopTail).map((metric) => metric.recall))
    : 0;
  const accuracyPass =
    rmsleImprovement >= 0.02 &&
    (test?.within2x ?? 0) >= (bestBaselineEntry?.[1].within2x ?? 0) - 0.01;
  const discoveryPass =
    (testTopTail?.recall ?? 0) >= bestBaselineTailRecall + 0.05 &&
    (test?.rmsle ?? Number.POSITIVE_INFINITY) <=
      (bestBaselineEntry?.[1].rmsle ?? Number.POSITIVE_INFINITY) * 1.15;
  const releaseGate: PriceModelReleaseGate = {
    passed:
      data.split.strategy === "temporal-group" &&
      Boolean(test) &&
      (test?.count ?? 0) >= PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE &&
      confidenceCalibration !== undefined &&
      (accuracyPass || discoveryPass),
    reason:
      data.split.strategy !== "temporal-group"
        ? "non-temporal-evaluation"
        : (test?.count ?? 0) < PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE
        ? "insufficient-test-data"
        : confidenceCalibration === undefined
          ? "uncalibrated-confidence"
          : accuracyPass || discoveryPass
            ? "passed"
            : "did-not-beat-baseline",
    minimumTestSize: PRICE_MODEL_RELEASE_GATE_MINIMUM_TEST_SIZE,
    bestBaseline: bestBaselineEntry?.[0] ?? "globalMedian",
    rmsleImprovement,
  };
  const trainedThrough = latestIso(history);
  if (trainedThrough === undefined) {
    throw new RangeError("Training history has no valid event or observation timestamp.");
  }
  const capabilities: PriceModelCapabilities = {
    intervalCalibrated: true,
    confidenceCalibrated: confidenceCalibration !== undefined,
    temporalEvaluation: data.split.strategy === "temporal-group",
    approved: releaseGate.passed,
  };

  return {
    schemaVersion: PRICE_MODEL_SCHEMA_VERSION,
    mlp: primary.json,
    ensemble: members.map((member) => member.json),
    ridge: ridge.toJSON(),
    gbt: gbt.toJSON(),
    tailClassifiers: tailClassifiers.map(({ thresholdTon, model }) => ({
      thresholdTon,
      model: model.toJSON(),
    })),
    stacker: stacker.toJSON(),
    stackFeatureNames,
    comparablePipelineVersion: COMPARABLE_PIPELINE_VERSION,
    comparablePipelineHash: comparablePipelineHash(),
    featureMean: data.featureMean,
    featureStd: data.featureStd,
    featureNames: [...FEATURE_NAMES],
    featureSchemaHash: featureSchemaHash(),
    targetMean: data.targetMean,
    targetStd: data.targetStd,
    trainedOn: history.length,
    trainedAt: new Date().toISOString(),
    trainedThrough,
    dataHash: priceHistoryDataHash(history),
    comparableBlendScale,
    calibration,
    oodCalibration,
    ...(confidenceCalibration ? { confidenceCalibration } : {}),
    split: data.split,
    releaseGate,
    capabilities,
    metrics: {
      bestEpoch: primary.bestEpoch,
      trainMse: mse(
        MLP.fromJSON(primary.json),
        data.trainInputs,
        data.trainTargets,
        data.trainWeights,
      ),
      validationMse: mse(
        MLP.fromJSON(primary.json),
        data.validationInputs,
        data.validationTargets,
        data.validationRecords.map(soldRecordTrainingWeight),
      ),
      ensembleTrainMse: ensembleMse(
        stackModels,
        stacker,
        data.trainInputs,
        data.trainTargets,
        data.trainWeights,
      ),
      ensembleValidationMse: ensembleMse(
        stackModels,
        stacker,
        data.validationInputs,
        data.validationTargets,
        data.validationRecords.map(soldRecordTrainingWeight),
      ),
      gbtTrainMse: gbt.training.trainMse,
      gbtValidationMse: gbt.training.validationMse,
      trainingSize: data.trainingRecords.length,
      validationSize: data.validationRecords.length,
      calibrationSize: data.calibrationRecords.length,
      blendSelectionSize: blendSelectionRecords.length,
      residualCalibrationSize: residualCalibrationRecords.length,
      confidenceCalibrationSize: confidenceCalibrationRecords.length,
      calibrationUnusedSize:
        data.calibrationRecords.length - usedCalibrationIndexes.size,
      finalCalibrationSize: residualCalibrationRecords.length,
      stackerSize: data.stackerRecords.length,
      testSize: data.testRecords.length,
      test,
      testModelOnly,
      testInterval,
      baselines,
      testTopTail,
      baselineTopTail,
      testSlices,
      comparableBlendScale,
    },
  };
}

export function trainPriceModel(opts: PriceTrainingOptions = {}): void {
  const history = loadSoldHistory();
  if (history.length < 30) {
    throw new Error(
      `Only ${history.length} valid sale records are available; at least 30 are required.`,
    );
  }

  const modelFile = fitPriceModel(history, opts);
  writeJsonAtomic(MODEL_PATH, modelFile);
  const metrics = modelFile.metrics;
  console.log(
    `\n${modelFile.releaseGate?.passed ? "Approved" : "Candidate"} price ensemble saved to ${MODEL_PATH}: ${modelFile.ensemble?.length ?? 1} members, ` +
      `${modelFile.trainedOn} events, schema ${modelFile.schemaVersion}.`,
  );
  if (metrics?.test) {
    const testLabel =
      modelFile.split?.strategy === "temporal-group"
        ? "Untouched temporal test"
        : "Held-out non-temporal test (diagnostic only)";
    console.log(
      `${testLabel}: RMSLE=${metrics.test.rmsle.toFixed(3)}, ` +
      `median factor=${metrics.test.medianFactorError.toFixed(2)}x, ` +
      `within 2x=${(metrics.test.within2x * 100).toFixed(1)}%, ` +
        `Spearman=${metrics.test.spearman.toFixed(3)}, ` +
        `top-5% recall=${((metrics.testTopTail?.recall ?? 0) * 100).toFixed(1)}%.`,
    );
  }
  if (metrics?.testInterval) {
    console.log(
      `P10-P90 empirical coverage=${(metrics.testInterval.coverage * 100).toFixed(1)}%.`,
    );
  }
  const gate = modelFile.releaseGate;
  if (gate) {
    console.log(
      `Release gate: ${gate.passed ? "PASS" : "FAIL"} (${gate.reason}); ` +
        `RMSLE improvement over ${gate.bestBaseline}=${(gate.rmsleImprovement * 100).toFixed(1)}%.`,
    );
  }
}
