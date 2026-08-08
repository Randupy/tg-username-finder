import type { SoldRecord } from "../priceData/soldHistory.js";
import {
  fitPriceModel,
  type PriceModelMetrics,
  type PriceModelReleaseGate,
  type PriceModelSplitMetadata,
  type PriceTrainingOptions,
} from "./train.js";

const DEFAULT_RUNS = 5;
const DEFAULT_BASE_SEED = 0x4b1d_5eed;
const SEED_STRIDE = 104_729;
const MAX_RUNS = 100;
const MAX_SEED = 0x7fff_ffff;

const BACKTEST_OPTION_KEYS = new Set(["runs", "baseSeed", "seeds", "training"]);
const TRAINING_OPTION_KEYS = new Set([
  "epochs",
  "hiddenSizes",
  "valFraction",
  "stackerFraction",
  "calibrationFraction",
  "testFraction",
  "batchSize",
  "learningRate",
  "ensembleSize",
  "ridgeLambda",
  "gbtTrees",
  "gbtMaxDepth",
  "stackerLambda",
  "earlyStoppingRounds",
  "splitStrategy",
]);

export type PriceBacktestTrainingOptions = Omit<PriceTrainingOptions, "seed">;

export interface PriceModelBacktestOptions {
  /** Number of generated seeds. Mutually exclusive with `seeds`. Default: 5. */
  runs?: number;
  /** First generated seed. Mutually exclusive with `seeds`. */
  baseSeed?: number;
  /** Explicit, unique seeds. Mutually exclusive with `runs` and `baseSeed`. */
  seeds?: readonly number[];
  /** Options passed to every in-memory fit. `seed` is deliberately forbidden. */
  training?: PriceBacktestTrainingOptions;
}

export interface PriceModelBacktestRun {
  seed: number;
  split: PriceModelSplitMetadata;
  /** Complete fit metrics are retained so later analyses do not require retraining. */
  metrics: PriceModelMetrics;
  releaseGate: PriceModelReleaseGate;
}

export interface PriceModelBacktestMetricSummary {
  mean: number;
  /** Population standard deviation across seeds (zero for one run). */
  std: number;
  min: number;
  max: number;
}

export interface PriceModelBacktestSummary {
  testRmsle: PriceModelBacktestMetricSummary;
  testMeanAbsoluteLogError: PriceModelBacktestMetricSummary;
  testWithin2x: PriceModelBacktestMetricSummary;
  testSpearman: PriceModelBacktestMetricSummary;
  testTopTailRecall: PriceModelBacktestMetricSummary;
  testIntervalCoverage: PriceModelBacktestMetricSummary;
  /** Boolean gate outcomes represented as 0/1; `mean` is the pass rate. */
  releaseGatePass: PriceModelBacktestMetricSummary;
}

export interface PriceModelBacktestResult {
  runCount: number;
  seeds: number[];
  runs: PriceModelBacktestRun[];
  summary: PriceModelBacktestSummary;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RangeError(`${label} contains unknown option(s): ${unknown.join(", ")}.`);
  }
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value as number;
}

function positiveFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
  return value;
}

function validSeed(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SEED
  ) {
    throw new RangeError(`${label} must be an integer from 0 to ${MAX_SEED}.`);
  }
  return value;
}

function validateFraction(value: unknown, label: string, allowZero: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 1 ||
    (!allowZero && value === 0)
  ) {
    throw new RangeError(
      `${label} must be ${allowZero ? "at least 0" : "greater than 0"} and less than 1.`,
    );
  }
  return value;
}

function validateTrainingOptions(value: unknown): PriceBacktestTrainingOptions {
  if (value === undefined) return {};
  assertPlainObject(value, "training");
  assertKnownKeys(value, TRAINING_OPTION_KEYS, "training");

  const result = { ...value } as PriceBacktestTrainingOptions;
  const epochs = value.epochs === undefined
    ? 100
    : positiveInteger(value.epochs, "training.epochs", Number.MAX_SAFE_INTEGER);
  if (value.epochs !== undefined) result.epochs = epochs;

  if (value.hiddenSizes !== undefined) {
    if (!Array.isArray(value.hiddenSizes) || value.hiddenSizes.length === 0) {
      throw new RangeError("training.hiddenSizes must be a non-empty array.");
    }
    result.hiddenSizes = value.hiddenSizes.map((size, index) =>
      positiveInteger(size, `training.hiddenSizes[${index}]`, 10_000),
    );
  }
  if (value.batchSize !== undefined) {
    result.batchSize = positiveInteger(
      value.batchSize,
      "training.batchSize",
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (value.learningRate !== undefined) {
    result.learningRate = positiveFinite(value.learningRate, "training.learningRate");
  }
  if (value.ensembleSize !== undefined) {
    result.ensembleSize = positiveInteger(value.ensembleSize, "training.ensembleSize", 9);
  }
  if (value.ridgeLambda !== undefined) {
    result.ridgeLambda = positiveFinite(value.ridgeLambda, "training.ridgeLambda");
  }
  if (value.gbtTrees !== undefined) {
    result.gbtTrees = positiveInteger(value.gbtTrees, "training.gbtTrees", 2_000);
  }
  if (value.gbtMaxDepth !== undefined) {
    result.gbtMaxDepth = positiveInteger(value.gbtMaxDepth, "training.gbtMaxDepth", 8);
  }
  if (value.stackerLambda !== undefined) {
    result.stackerLambda = positiveFinite(value.stackerLambda, "training.stackerLambda");
  }
  if (value.earlyStoppingRounds !== undefined) {
    const rounds = positiveInteger(
      value.earlyStoppingRounds,
      "training.earlyStoppingRounds",
      epochs,
    );
    result.earlyStoppingRounds = rounds;
  }
  if (
    value.splitStrategy !== undefined &&
    value.splitStrategy !== "temporal-group" &&
    value.splitStrategy !== "random"
  ) {
    throw new RangeError(
      'training.splitStrategy must be either "temporal-group" or "random".',
    );
  }

  const valFraction = value.valFraction === undefined
    ? 0.15
    : validateFraction(value.valFraction, "training.valFraction", false);
  const calibrationFraction = value.calibrationFraction === undefined
    ? 0.1
    : validateFraction(
        value.calibrationFraction,
        "training.calibrationFraction",
        false,
      );
  const stackerFraction = value.stackerFraction === undefined
    ? 0.1
    : validateFraction(value.stackerFraction, "training.stackerFraction", false);
  const testFraction = value.testFraction === undefined
    ? 0.1
    : validateFraction(value.testFraction, "training.testFraction", false);
  if (valFraction + stackerFraction + calibrationFraction + testFraction >= 0.8) {
    throw new RangeError("training holdout fractions must leave at least 20% for training.");
  }
  if (value.valFraction !== undefined) result.valFraction = valFraction;
  if (value.stackerFraction !== undefined) result.stackerFraction = stackerFraction;
  if (value.calibrationFraction !== undefined) {
    result.calibrationFraction = calibrationFraction;
  }
  if (value.testFraction !== undefined) result.testFraction = testFraction;

  return result;
}

/** Returns a deterministic, collision-free sequence within the supported run limit. */
export function deterministicPriceBacktestSeeds(
  runs = DEFAULT_RUNS,
  baseSeed = DEFAULT_BASE_SEED,
): number[] {
  const count = positiveInteger(runs, "runs", MAX_RUNS);
  const first = validSeed(baseSeed, "baseSeed");
  return Array.from(
    { length: count },
    (_, index) => (first + index * SEED_STRIDE) % (MAX_SEED + 1),
  );
}

function resolveOptions(options: PriceModelBacktestOptions | undefined): {
  seeds: number[];
  training: PriceBacktestTrainingOptions;
} {
  if (options === undefined) {
    return {
      seeds: deterministicPriceBacktestSeeds(),
      training: {},
    };
  }
  assertPlainObject(options, "options");
  assertKnownKeys(options, BACKTEST_OPTION_KEYS, "options");

  if (options.seeds !== undefined) {
    if (options.runs !== undefined || options.baseSeed !== undefined) {
      throw new RangeError("options.seeds is mutually exclusive with runs and baseSeed.");
    }
    if (!Array.isArray(options.seeds) || options.seeds.length === 0) {
      throw new RangeError("options.seeds must be a non-empty array.");
    }
    if (options.seeds.length > MAX_RUNS) {
      throw new RangeError(`options.seeds may contain at most ${MAX_RUNS} entries.`);
    }
    const seeds = options.seeds.map((seed, index) =>
      validSeed(seed, `options.seeds[${index}]`),
    );
    if (new Set(seeds).size !== seeds.length) {
      throw new RangeError("options.seeds must contain unique values.");
    }
    return { seeds, training: validateTrainingOptions(options.training) };
  }

  const runs = options.runs === undefined
    ? DEFAULT_RUNS
    : positiveInteger(options.runs, "runs", MAX_RUNS);
  const baseSeed = options.baseSeed === undefined
    ? DEFAULT_BASE_SEED
    : validSeed(options.baseSeed, "baseSeed");
  return {
    seeds: deterministicPriceBacktestSeeds(runs, baseSeed),
    training: validateTrainingOptions(options.training),
  };
}

function validateHistory(history: readonly SoldRecord[]): void {
  if (!Array.isArray(history) || history.length < 10) {
    throw new RangeError(
      "A backtest requires at least 10 records so the final test cohort is non-empty.",
    );
  }
  history.forEach((record, index) => {
    if (record === null || typeof record !== "object") {
      throw new TypeError(`history[${index}] must be a SoldRecord object.`);
    }
    if (typeof record.username !== "string" || record.username.length === 0) {
      throw new RangeError(`history[${index}].username must be a non-empty string.`);
    }
    if (!Number.isFinite(record.priceTon) || record.priceTon <= 0) {
      throw new RangeError(`history[${index}].priceTon must be a positive finite number.`);
    }
    if (
      typeof record.scrapedAt !== "string" ||
      !Number.isFinite(Date.parse(record.scrapedAt))
    ) {
      throw new RangeError(`history[${index}].scrapedAt must be a valid ISO timestamp.`);
    }
    if (
      record.saleAt !== undefined &&
      (typeof record.saleAt !== "string" || !Number.isFinite(Date.parse(record.saleAt)))
    ) {
      throw new RangeError(`history[${index}].saleAt must be a valid timestamp when set.`);
    }
  });
}

function summarize(values: readonly number[]): PriceModelBacktestMetricSummary {
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("Cannot summarize missing or non-finite backtest metrics.");
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean,
    std: Math.sqrt(Math.max(0, variance)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function requireRunMetrics(run: PriceModelBacktestRun): {
  rmsle: number;
  meanAbsoluteLogError: number;
  within2x: number;
  spearman: number;
  topTailRecall: number;
  coverage: number;
} {
  const test = run.metrics.test;
  const topTail = run.metrics.testTopTail;
  const interval = run.metrics.testInterval;
  if (!test || !topTail || !interval) {
    throw new Error(
      `Seed ${run.seed} produced no complete test metrics; use at least 10 records and a positive testFraction.`,
    );
  }
  return {
    rmsle: test.rmsle,
    meanAbsoluteLogError: test.meanAbsoluteLogError,
    within2x: test.within2x,
    spearman: test.spearman,
    topTailRecall: topTail.recall,
    coverage: interval.coverage,
  };
}

/**
 * Fits the price model repeatedly in memory and aggregates untouched-test
 * metrics. No model artifact or other file is written.
 */
export function backtestPriceModel(
  history: readonly SoldRecord[],
  options?: PriceModelBacktestOptions,
): PriceModelBacktestResult {
  const resolved = resolveOptions(options);
  validateHistory(history);

  const runs: PriceModelBacktestRun[] = resolved.seeds.map((seed) => {
    const fitted = fitPriceModel(history, { ...resolved.training, seed });
    if (!fitted.metrics || !fitted.split || !fitted.releaseGate) {
      throw new Error(`Seed ${seed} produced an incomplete model evaluation artifact.`);
    }
    return {
      seed,
      split: fitted.split,
      metrics: fitted.metrics,
      releaseGate: fitted.releaseGate,
    };
  });
  const values = runs.map(requireRunMetrics);

  return {
    runCount: runs.length,
    seeds: runs.map((run) => run.seed),
    runs,
    summary: {
      testRmsle: summarize(values.map((value) => value.rmsle)),
      testMeanAbsoluteLogError: summarize(
        values.map((value) => value.meanAbsoluteLogError),
      ),
      testWithin2x: summarize(values.map((value) => value.within2x)),
      testSpearman: summarize(values.map((value) => value.spearman)),
      testTopTailRecall: summarize(values.map((value) => value.topTailRecall)),
      testIntervalCoverage: summarize(values.map((value) => value.coverage)),
      releaseGatePass: summarize(
        runs.map((run) => (run.releaseGate.passed ? 1 : 0)),
      ),
    },
  };
}

/** Verb-oriented alias for callers that prefer an explicit runner name. */
export const runPriceModelBacktest = backtestPriceModel;
