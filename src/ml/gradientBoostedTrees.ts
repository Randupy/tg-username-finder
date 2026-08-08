/**
 * Dependency-free gradient-boosted regression trees for dense tabular data.
 *
 * Training uses squared-error residual boosting and histogram/quantile split
 * candidates. Feature bins are built once, which keeps shallow-tree training
 * practical for the price model's roughly 9k rows by 129 features.
 */

export const GRADIENT_BOOSTED_TREES_SCHEMA_VERSION = 1 as const;

export interface GradientBoostedTreesValidationSet {
  readonly inputs: readonly (readonly number[])[];
  readonly targets: readonly number[];
  /** Optional positive observation weights used by validation MSE. */
  readonly sampleWeights?: readonly number[];
}

export interface GradientBoostedTreesOptions {
  /** Optional positive observation weights used throughout fitting. */
  readonly sampleWeights?: readonly number[];
  /** Maximum boosting rounds. Default: 120. */
  readonly trees?: number;
  /** Shrinkage applied to every tree. Default: 0.05. */
  readonly learningRate?: number;
  /** Maximum tree depth; zero creates constant trees. Default: 3. */
  readonly maxDepth?: number;
  /** Minimum sampled rows in every leaf. Default: 20. */
  readonly minLeaf?: number;
  /** Fraction of training rows sampled per tree. Default: 0.8. */
  readonly rowSubsample?: number;
  /** Fraction of features sampled per tree. Default: 0.6. */
  readonly featureSubsample?: number;
  /** Maximum quantile bins per feature. Default: 64. */
  readonly maxBins?: number;
  /** Minimum squared-error reduction required for a split. Default: 0. */
  readonly minGain?: number;
  /** Deterministic PRNG seed. Default: 0x6d2b79f5. */
  readonly seed?: number;
  /** Optional holdout used only for early stopping. */
  readonly validation?: GradientBoostedTreesValidationSet;
  /**
   * Stop after this many non-improving validation rounds. Defaults to 20 when
   * validation is present and zero otherwise.
   */
  readonly earlyStoppingRounds?: number;
  /** Absolute validation-MSE improvement required to reset patience. */
  readonly minImprovement?: number;
}

export interface GradientBoostedTreesConfig {
  readonly trees: number;
  readonly learningRate: number;
  readonly maxDepth: number;
  readonly minLeaf: number;
  readonly rowSubsample: number;
  readonly featureSubsample: number;
  readonly maxBins: number;
  readonly minGain: number;
  readonly seed: number;
  readonly earlyStoppingRounds: number;
  readonly minImprovement: number;
}

export interface GradientBoostedTreesTrainingSummary {
  readonly requestedTrees: number;
  /** Trees actually attempted before patience stopped training. */
  readonly attemptedTrees: number;
  /** Best-prefix trees retained by the model. */
  readonly fittedTrees: number;
  readonly stoppedEarly: boolean;
  readonly trainMse: number;
  readonly validationMse?: number;
}

export interface RegressionLeafJSON {
  readonly kind: "leaf";
  readonly value: number;
  readonly samples: number;
}

export interface RegressionSplitJSON {
  readonly kind: "split";
  readonly featureIndex: number;
  readonly threshold: number;
  readonly gain: number;
  readonly samples: number;
  readonly left: RegressionTreeNodeJSON;
  readonly right: RegressionTreeNodeJSON;
}

export type RegressionTreeNodeJSON = RegressionLeafJSON | RegressionSplitJSON;

export interface GradientBoostedTreesJSON {
  readonly modelType: "gradient-boosted-trees-regressor";
  readonly schemaVersion: typeof GRADIENT_BOOSTED_TREES_SCHEMA_VERSION;
  readonly featureCount: number;
  readonly baseValue: number;
  readonly config: GradientBoostedTreesConfig;
  readonly training: GradientBoostedTreesTrainingSummary;
  readonly trees: readonly RegressionTreeNodeJSON[];
}

interface BinnedTrainingData {
  readonly thresholds: readonly (readonly number[])[];
  readonly columns: readonly Uint16Array[];
}

interface SplitCandidate {
  readonly featureIndex: number;
  readonly splitBin: number;
  readonly threshold: number;
  readonly gain: number;
}

const DEFAULT_SEED = 0x6d2b79f5;
const CONFIG_FIELDS = new Set([
  "trees",
  "learningRate",
  "maxDepth",
  "minLeaf",
  "rowSubsample",
  "featureSubsample",
  "maxBins",
  "minGain",
  "seed",
  "earlyStoppingRounds",
  "minImprovement",
]);
const TRAINING_FIELDS = new Set([
  "requestedTrees",
  "attemptedTrees",
  "fittedTrees",
  "stoppedEarly",
  "trainMse",
  "validationMse",
]);
const MODEL_FIELDS = new Set([
  "modelType",
  "schemaVersion",
  "featureCount",
  "baseValue",
  "config",
  "training",
  "trees",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`${label}.${field} is not supported.`);
  }
}

function finiteNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${name} must be a finite number in [${minimum}, ${maximum}].`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${name} must be a safe integer in [${minimum}, ${maximum}].`);
  }
  return value;
}

function resolveConfig(
  options: GradientBoostedTreesOptions,
  rowCount: number,
): GradientBoostedTreesConfig {
  const hasValidation = options.validation !== undefined;
  return Object.freeze({
    trees: integer(options.trees ?? 120, "trees", 1, 2_000),
    learningRate: finiteNumber(
      options.learningRate ?? 0.05,
      "learningRate",
      Number.EPSILON,
      1,
    ),
    maxDepth: integer(options.maxDepth ?? 3, "maxDepth", 0, 12),
    minLeaf: integer(options.minLeaf ?? Math.min(20, rowCount), "minLeaf", 1, rowCount),
    rowSubsample: finiteNumber(
      options.rowSubsample ?? 0.8,
      "rowSubsample",
      Number.EPSILON,
      1,
    ),
    featureSubsample: finiteNumber(
      options.featureSubsample ?? 0.6,
      "featureSubsample",
      Number.EPSILON,
      1,
    ),
    maxBins: integer(options.maxBins ?? 64, "maxBins", 2, 1_024),
    minGain: finiteNumber(options.minGain ?? 0, "minGain", 0),
    seed: integer(options.seed ?? DEFAULT_SEED, "seed", -0x80000000, 0xffffffff),
    earlyStoppingRounds: integer(
      options.earlyStoppingRounds ?? (hasValidation ? 20 : 0),
      "earlyStoppingRounds",
      0,
      2_000,
    ),
    minImprovement: finiteNumber(
      options.minImprovement ?? 1e-9,
      "minImprovement",
      0,
    ),
  });
}

function validateMatrix(
  inputs: readonly (readonly number[])[],
  label: string,
  expectedFeatures?: number,
): number {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new RangeError(`${label} must contain at least one row.`);
  }
  const featureCount = inputs[0]?.length ?? 0;
  if (featureCount === 0 || (expectedFeatures !== undefined && featureCount !== expectedFeatures)) {
    throw new RangeError(
      `${label} must have ${expectedFeatures ?? "a positive number of"} features.`,
    );
  }
  for (let rowIndex = 0; rowIndex < inputs.length; rowIndex++) {
    const row = inputs[rowIndex];
    if (
      !Array.isArray(row) ||
      row.length !== featureCount ||
      row.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new RangeError(`${label}[${rowIndex}] is not a finite rectangular row.`);
    }
  }
  return featureCount;
}

function validateTargets(
  targets: readonly number[],
  rowCount: number,
  label: string,
): void {
  if (
    !Array.isArray(targets) ||
    targets.length !== rowCount ||
    targets.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new RangeError(`${label} must contain one finite value per row.`);
  }
}

function validateSampleWeights(
  values: readonly number[] | undefined,
  rowCount: number,
  label: string,
): Float64Array {
  if (values === undefined) {
    const weights = new Float64Array(rowCount);
    weights.fill(1);
    return weights;
  }
  if (
    !Array.isArray(values) ||
    values.length !== rowCount ||
    values.some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0,
    )
  ) {
    throw new RangeError(`${label} must contain one positive finite value per row.`);
  }

  // Preserve relative weights while keeping their mean at one. This avoids
  // overflow for large-but-finite inputs and keeps minGain on its usual scale.
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  const relative = values.map((value) =>
    Math.max(Number.MIN_VALUE, value / maximum),
  );
  const relativeTotal = relative.reduce((sum, value) => sum + value, 0);
  const scale = rowCount / relativeTotal;
  return Float64Array.from(relative, (value) =>
    Math.max(Number.MIN_VALUE, value * scale),
  );
}

function stableMean(values: readonly number[], weights: ArrayLike<number>): number {
  let mean = 0;
  let totalWeight = 0;
  for (let index = 0; index < values.length; index++) {
    totalWeight += weights[index];
    mean += (values[index] - mean) * (weights[index] / totalWeight);
  }
  if (!Number.isFinite(mean)) throw new RangeError("Target mean is not finite.");
  return mean;
}

function mse(
  targets: readonly number[],
  predictions: ArrayLike<number>,
  weights: ArrayLike<number>,
): number {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (let index = 0; index < targets.length; index++) {
    const residual = targets[index] - predictions[index];
    const squared = residual * residual;
    if (!Number.isFinite(squared)) {
      throw new RangeError("Squared-error loss became non-finite.");
    }
    weightedTotal += weights[index] * squared;
    totalWeight += weights[index];
  }
  const result = weightedTotal / totalWeight;
  if (!Number.isFinite(result)) {
    throw new RangeError("Weighted squared-error loss became non-finite.");
  }
  return result;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleIndexes(count: number, take: number, random: () => number): number[] {
  if (take >= count) return Array.from({ length: count }, (_, index) => index);
  const indexes = Array.from({ length: count }, (_, index) => index);
  for (let index = 0; index < take; index++) {
    const selected = index + Math.floor(random() * (count - index));
    [indexes[index], indexes[selected]] = [indexes[selected], indexes[index]];
  }
  return indexes.slice(0, take);
}

function quantileThresholds(
  inputs: readonly (readonly number[])[],
  featureIndex: number,
  maxBins: number,
): number[] {
  const sorted = inputs
    .map((row) => row[featureIndex])
    .sort((left, right) => left - right);
  const thresholds: number[] = [];
  for (let bin = 1; bin < maxBins; bin++) {
    const splitIndex = Math.floor((bin * sorted.length) / maxBins);
    if (splitIndex <= 0 || splitIndex >= sorted.length) continue;
    const left = sorted[splitIndex - 1];
    const right = sorted[splitIndex];
    if (left >= right) continue;
    // Splitting on the largest observed value below the gap is exact and
    // avoids midpoint overflow for very large finite feature values.
    if (thresholds[thresholds.length - 1] !== left) thresholds.push(left);
  }
  return thresholds;
}

function binForValue(value: number, thresholds: readonly number[]): number {
  let lower = 0;
  let upper = thresholds.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (value <= thresholds[middle]) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }
  return lower;
}

function buildBinnedData(
  inputs: readonly (readonly number[])[],
  featureCount: number,
  maxBins: number,
): BinnedTrainingData {
  const thresholds: number[][] = [];
  const columns: Uint16Array[] = [];
  for (let featureIndex = 0; featureIndex < featureCount; featureIndex++) {
    const featureThresholds = quantileThresholds(inputs, featureIndex, maxBins);
    const column = new Uint16Array(inputs.length);
    for (let rowIndex = 0; rowIndex < inputs.length; rowIndex++) {
      column[rowIndex] = binForValue(inputs[rowIndex][featureIndex], featureThresholds);
    }
    thresholds.push(featureThresholds);
    columns.push(column);
  }
  return { thresholds, columns };
}

function sumWeightedRows(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  rows: readonly number[],
): { weightedSum: number; weight: number } {
  let sum = 0;
  let weight = 0;
  for (const row of rows) {
    sum += weights[row] * values[row];
    weight += weights[row];
  }
  if (!Number.isFinite(sum) || !Number.isFinite(weight) || weight <= 0) {
    throw new RangeError("Weighted residual statistics became invalid.");
  }
  return { weightedSum: sum, weight };
}

function betterSplit(
  gain: number,
  featureIndex: number,
  splitBin: number,
  best: SplitCandidate | null,
): boolean {
  if (best === null) return true;
  const tolerance = 1e-12 * Math.max(1, Math.abs(gain), Math.abs(best.gain));
  if (gain > best.gain + tolerance) return true;
  if (Math.abs(gain - best.gain) <= tolerance) {
    return (
      featureIndex < best.featureIndex ||
      (featureIndex === best.featureIndex && splitBin < best.splitBin)
    );
  }
  return false;
}

function findBestSplit(
  rows: readonly number[],
  residuals: Float64Array,
  sampleWeights: Float64Array,
  selectedFeatures: readonly number[],
  binned: BinnedTrainingData,
  minLeaf: number,
  minGain: number,
  totalSum: number,
  totalWeight: number,
  countScratch: Uint32Array,
  sumScratch: Float64Array,
  weightScratch: Float64Array,
): SplitCandidate | null {
  let best: SplitCandidate | null = null;
  const parentScore = (totalSum * totalSum) / totalWeight;

  for (const featureIndex of selectedFeatures) {
    const thresholds = binned.thresholds[featureIndex];
    if (thresholds.length === 0) continue;
    const binCount = thresholds.length + 1;
    countScratch.fill(0, 0, binCount);
    sumScratch.fill(0, 0, binCount);
    weightScratch.fill(0, 0, binCount);
    const column = binned.columns[featureIndex];
    for (const row of rows) {
      const bin = column[row];
      countScratch[bin]++;
      sumScratch[bin] += sampleWeights[row] * residuals[row];
      weightScratch[bin] += sampleWeights[row];
    }

    let leftCount = 0;
    let leftSum = 0;
    let leftWeight = 0;
    for (let splitBin = 0; splitBin < binCount - 1; splitBin++) {
      leftCount += countScratch[splitBin];
      leftSum += sumScratch[splitBin];
      leftWeight += weightScratch[splitBin];
      const rightCount = rows.length - leftCount;
      if (leftCount < minLeaf || rightCount < minLeaf) continue;
      const rightSum = totalSum - leftSum;
      const rightWeight = totalWeight - leftWeight;
      const gain =
        (leftSum * leftSum) / leftWeight +
        (rightSum * rightSum) / rightWeight -
        parentScore;
      if (
        Number.isFinite(gain) &&
        gain > minGain &&
        betterSplit(gain, featureIndex, splitBin, best)
      ) {
        best = {
          featureIndex,
          splitBin,
          threshold: thresholds[splitBin],
          gain,
        };
      }
    }
  }
  return best;
}

function buildTree(
  rows: readonly number[],
  residuals: Float64Array,
  sampleWeights: Float64Array,
  selectedFeatures: readonly number[],
  binned: BinnedTrainingData,
  depth: number,
  config: GradientBoostedTreesConfig,
  countScratch: Uint32Array,
  sumScratch: Float64Array,
  weightScratch: Float64Array,
): RegressionTreeNodeJSON {
  const { weightedSum: totalSum, weight: totalWeight } = sumWeightedRows(
    residuals,
    sampleWeights,
    rows,
  );
  const leafValue = totalSum / totalWeight;
  if (!Number.isFinite(leafValue)) {
    throw new RangeError("Tree leaf value became non-finite.");
  }
  if (depth >= config.maxDepth || rows.length < config.minLeaf * 2) {
    return Object.freeze({ kind: "leaf", value: leafValue, samples: rows.length });
  }

  const split = findBestSplit(
    rows,
    residuals,
    sampleWeights,
    selectedFeatures,
    binned,
    config.minLeaf,
    config.minGain,
    totalSum,
    totalWeight,
    countScratch,
    sumScratch,
    weightScratch,
  );
  if (split === null) {
    return Object.freeze({ kind: "leaf", value: leafValue, samples: rows.length });
  }

  const leftRows: number[] = [];
  const rightRows: number[] = [];
  const column = binned.columns[split.featureIndex];
  for (const row of rows) {
    (column[row] <= split.splitBin ? leftRows : rightRows).push(row);
  }
  if (leftRows.length < config.minLeaf || rightRows.length < config.minLeaf) {
    throw new Error("Internal split violated minLeaf.");
  }

  return Object.freeze({
    kind: "split",
    featureIndex: split.featureIndex,
    threshold: split.threshold,
    gain: split.gain,
    samples: rows.length,
    left: buildTree(
      leftRows,
      residuals,
      sampleWeights,
      selectedFeatures,
      binned,
      depth + 1,
      config,
      countScratch,
      sumScratch,
      weightScratch,
    ),
    right: buildTree(
      rightRows,
      residuals,
      sampleWeights,
      selectedFeatures,
      binned,
      depth + 1,
      config,
      countScratch,
      sumScratch,
      weightScratch,
    ),
  });
}

function predictTree(tree: RegressionTreeNodeJSON, input: readonly number[]): number {
  let node = tree;
  while (node.kind === "split") {
    node = input[node.featureIndex] <= node.threshold ? node.left : node.right;
  }
  return node.value;
}

function cloneTree(tree: RegressionTreeNodeJSON): RegressionTreeNodeJSON {
  return tree.kind === "leaf"
    ? { kind: "leaf", value: tree.value, samples: tree.samples }
    : {
        kind: "split",
        featureIndex: tree.featureIndex,
        threshold: tree.threshold,
        gain: tree.gain,
        samples: tree.samples,
        left: cloneTree(tree.left),
        right: cloneTree(tree.right),
      };
}

function validateTree(
  value: unknown,
  featureCount: number,
  maxDepth: number,
  depth: number,
  seen: WeakSet<object>,
): RegressionTreeNodeJSON {
  if (!isObject(value)) throw new TypeError("Tree node must be an object.");
  if (seen.has(value)) throw new TypeError("Tree JSON must not contain cycles or shared nodes.");
  seen.add(value);
  if (depth > maxDepth) throw new RangeError("Tree exceeds config.maxDepth.");

  if (value.kind === "leaf") {
    assertExactFields(value, new Set(["kind", "value", "samples"]), "leaf");
    const leaf: RegressionLeafJSON = {
      kind: "leaf",
      value: finiteNumber(value.value, "leaf.value", -Number.MAX_VALUE, Number.MAX_VALUE),
      samples: integer(value.samples, "leaf.samples", 1),
    };
    return Object.freeze(leaf);
  }
  if (value.kind !== "split") throw new TypeError("Tree node kind is invalid.");
  assertExactFields(
    value,
    new Set([
      "kind",
      "featureIndex",
      "threshold",
      "gain",
      "samples",
      "left",
      "right",
    ]),
    "split",
  );
  if (depth >= maxDepth) throw new RangeError("Split node exceeds config.maxDepth.");
  const samples = integer(value.samples, "split.samples", 2);
  const left = validateTree(value.left, featureCount, maxDepth, depth + 1, seen);
  const right = validateTree(value.right, featureCount, maxDepth, depth + 1, seen);
  if (left.samples + right.samples !== samples) {
    throw new RangeError("Split child sample counts do not add up.");
  }
  const split: RegressionSplitJSON = {
    kind: "split",
    featureIndex: integer(value.featureIndex, "split.featureIndex", 0, featureCount - 1),
    threshold: finiteNumber(
      value.threshold,
      "split.threshold",
      -Number.MAX_VALUE,
      Number.MAX_VALUE,
    ),
    gain: finiteNumber(value.gain, "split.gain", 0),
    samples,
    left,
    right,
  };
  return Object.freeze(split);
}

function validateConfig(value: unknown): GradientBoostedTreesConfig {
  if (!isObject(value)) throw new TypeError("config must be an object.");
  assertExactFields(value, CONFIG_FIELDS, "config");
  return Object.freeze({
    trees: integer(value.trees, "config.trees", 1, 2_000),
    learningRate: finiteNumber(
      value.learningRate,
      "config.learningRate",
      Number.EPSILON,
      1,
    ),
    maxDepth: integer(value.maxDepth, "config.maxDepth", 0, 12),
    minLeaf: integer(value.minLeaf, "config.minLeaf", 1),
    rowSubsample: finiteNumber(
      value.rowSubsample,
      "config.rowSubsample",
      Number.EPSILON,
      1,
    ),
    featureSubsample: finiteNumber(
      value.featureSubsample,
      "config.featureSubsample",
      Number.EPSILON,
      1,
    ),
    maxBins: integer(value.maxBins, "config.maxBins", 2, 1_024),
    minGain: finiteNumber(value.minGain, "config.minGain", 0),
    seed: integer(value.seed, "config.seed", -0x80000000, 0xffffffff),
    earlyStoppingRounds: integer(
      value.earlyStoppingRounds,
      "config.earlyStoppingRounds",
      0,
      2_000,
    ),
    minImprovement: finiteNumber(
      value.minImprovement,
      "config.minImprovement",
      0,
    ),
  });
}

function validateTrainingSummary(
  value: unknown,
  config: GradientBoostedTreesConfig,
  treeCount: number,
): GradientBoostedTreesTrainingSummary {
  if (!isObject(value)) throw new TypeError("training must be an object.");
  assertExactFields(value, TRAINING_FIELDS, "training");
  const requestedTrees = integer(
    value.requestedTrees,
    "training.requestedTrees",
    1,
    2_000,
  );
  const attemptedTrees = integer(
    value.attemptedTrees,
    "training.attemptedTrees",
    0,
    requestedTrees,
  );
  const fittedTrees = integer(
    value.fittedTrees,
    "training.fittedTrees",
    0,
    attemptedTrees,
  );
  if (requestedTrees !== config.trees || fittedTrees !== treeCount) {
    throw new RangeError("Training summary does not match config/trees.");
  }
  if (typeof value.stoppedEarly !== "boolean") {
    throw new TypeError("training.stoppedEarly must be boolean.");
  }
  const validationMse =
    value.validationMse === undefined
      ? undefined
      : finiteNumber(value.validationMse, "training.validationMse", 0);
  return Object.freeze({
    requestedTrees,
    attemptedTrees,
    fittedTrees,
    stoppedEarly: value.stoppedEarly,
    trainMse: finiteNumber(value.trainMse, "training.trainMse", 0),
    ...(validationMse === undefined ? {} : { validationMse }),
  });
}

export class GradientBoostedTrees {
  readonly featureCount: number;
  readonly baseValue: number;
  readonly config: GradientBoostedTreesConfig;
  readonly training: GradientBoostedTreesTrainingSummary;
  private readonly forest: readonly RegressionTreeNodeJSON[];

  private constructor(
    featureCount: number,
    baseValue: number,
    config: GradientBoostedTreesConfig,
    training: GradientBoostedTreesTrainingSummary,
    trees: readonly RegressionTreeNodeJSON[],
  ) {
    this.featureCount = featureCount;
    this.baseValue = baseValue;
    this.config = Object.freeze({ ...config });
    this.training = Object.freeze({ ...training });
    this.forest = Object.freeze([...trees]);
  }

  get treeCount(): number {
    return this.forest.length;
  }

  predict(input: readonly number[]): number {
    if (
      !Array.isArray(input) ||
      input.length !== this.featureCount ||
      input.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new RangeError(
        `Input must contain exactly ${this.featureCount} finite features.`,
      );
    }
    let prediction = this.baseValue;
    for (const tree of this.forest) {
      prediction += this.config.learningRate * predictTree(tree, input);
    }
    if (!Number.isFinite(prediction)) {
      throw new RangeError("Gradient-boosted-tree prediction became non-finite.");
    }
    return prediction;
  }

  predictBatch(inputs: readonly (readonly number[])[]): number[] {
    return inputs.map((input) => this.predict(input));
  }

  toJSON(): GradientBoostedTreesJSON {
    return {
      modelType: "gradient-boosted-trees-regressor",
      schemaVersion: GRADIENT_BOOSTED_TREES_SCHEMA_VERSION,
      featureCount: this.featureCount,
      baseValue: this.baseValue,
      config: { ...this.config },
      training: { ...this.training },
      trees: this.forest.map(cloneTree),
    };
  }

  static fromJSON(value: unknown): GradientBoostedTrees {
    if (!isObject(value)) throw new TypeError("GBT artifact must be an object.");
    assertExactFields(value, MODEL_FIELDS, "model");
    if (value.modelType !== "gradient-boosted-trees-regressor") {
      throw new TypeError("GBT modelType is incompatible.");
    }
    if (value.schemaVersion !== GRADIENT_BOOSTED_TREES_SCHEMA_VERSION) {
      throw new TypeError("GBT schemaVersion is incompatible.");
    }
    const featureCount = integer(value.featureCount, "featureCount", 1);
    const baseValue = finiteNumber(
      value.baseValue,
      "baseValue",
      -Number.MAX_VALUE,
      Number.MAX_VALUE,
    );
    const config = validateConfig(value.config);
    if (!Array.isArray(value.trees)) throw new TypeError("trees must be an array.");
    if (value.trees.length > config.trees) {
      throw new RangeError("Artifact contains more trees than config.trees.");
    }
    const seen = new WeakSet<object>();
    const trees = value.trees.map((tree) =>
      validateTree(tree, featureCount, config.maxDepth, 0, seen),
    );
    const training = validateTrainingSummary(
      value.training,
      config,
      trees.length,
    );
    return new GradientBoostedTrees(
      featureCount,
      baseValue,
      config,
      training,
      trees,
    );
  }

  static fit(
    inputs: readonly (readonly number[])[],
    targets: readonly number[],
    options: GradientBoostedTreesOptions = {},
  ): GradientBoostedTrees {
    const featureCount = validateMatrix(inputs, "inputs");
    validateTargets(targets, inputs.length, "targets");
    const sampleWeights = validateSampleWeights(
      options.sampleWeights,
      inputs.length,
      "sampleWeights",
    );
    const config = resolveConfig(options, inputs.length);

    const validation = options.validation;
    let validationWeights: Float64Array | undefined;
    if (validation !== undefined) {
      if (!isObject(validation)) throw new TypeError("validation must be an object.");
      validateMatrix(validation.inputs, "validation.inputs", featureCount);
      validateTargets(
        validation.targets,
        validation.inputs.length,
        "validation.targets",
      );
      validationWeights = validateSampleWeights(
        validation.sampleWeights,
        validation.inputs.length,
        "validation.sampleWeights",
      );
    } else if (options.earlyStoppingRounds !== undefined && options.earlyStoppingRounds > 0) {
      throw new RangeError("earlyStoppingRounds requires a validation set.");
    }

    const baseValue = stableMean(targets, sampleWeights);
    const predictions = new Float64Array(inputs.length);
    predictions.fill(baseValue);
    const validationPredictions =
      validation === undefined ? null : new Float64Array(validation.inputs.length);
    validationPredictions?.fill(baseValue);

    const binned = buildBinnedData(inputs, featureCount, config.maxBins);
    const residuals = new Float64Array(inputs.length);
    const countScratch = new Uint32Array(config.maxBins + 1);
    const sumScratch = new Float64Array(config.maxBins + 1);
    const weightScratch = new Float64Array(config.maxBins + 1);
    const random = mulberry32(config.seed);
    const trees: RegressionTreeNodeJSON[] = [];
    const rowSampleSize = Math.min(
      inputs.length,
      Math.max(
        Math.min(inputs.length, config.minLeaf * 2),
        Math.floor(inputs.length * config.rowSubsample),
        1,
      ),
    );
    const featureSampleSize = Math.min(
      featureCount,
      Math.max(1, Math.floor(featureCount * config.featureSubsample)),
    );

    let attemptedTrees = 0;
    let roundsWithoutImprovement = 0;
    let bestTreeCount = 0;
    let bestTrainingMse = mse(targets, predictions, sampleWeights);
    let bestValidationMse =
      validation === undefined
        ? undefined
        : mse(validation.targets, validationPredictions!, validationWeights!);

    for (let iteration = 0; iteration < config.trees; iteration++) {
      for (let rowIndex = 0; rowIndex < inputs.length; rowIndex++) {
        const residual = targets[rowIndex] - predictions[rowIndex];
        if (!Number.isFinite(residual)) {
          throw new RangeError("Residual became non-finite.");
        }
        residuals[rowIndex] = residual;
      }
      const sampledRows = sampleIndexes(inputs.length, rowSampleSize, random);
      const sampledFeatures = sampleIndexes(
        featureCount,
        featureSampleSize,
        random,
      ).sort((left, right) => left - right);
      const tree = buildTree(
        sampledRows,
        residuals,
        sampleWeights,
        sampledFeatures,
        binned,
        0,
        config,
        countScratch,
        sumScratch,
        weightScratch,
      );
      trees.push(tree);
      attemptedTrees++;

      for (let rowIndex = 0; rowIndex < inputs.length; rowIndex++) {
        predictions[rowIndex] +=
          config.learningRate * predictTree(tree, inputs[rowIndex]);
        if (!Number.isFinite(predictions[rowIndex])) {
          throw new RangeError("Training prediction became non-finite.");
        }
      }
      const trainingMse = mse(targets, predictions, sampleWeights);

      if (validation === undefined) {
        bestTreeCount = trees.length;
        bestTrainingMse = trainingMse;
        continue;
      }

      for (let rowIndex = 0; rowIndex < validation.inputs.length; rowIndex++) {
        validationPredictions![rowIndex] +=
          config.learningRate * predictTree(tree, validation.inputs[rowIndex]);
      }
      const validationMse = mse(
        validation.targets,
        validationPredictions!,
        validationWeights!,
      );
      if (
        bestValidationMse === undefined ||
        validationMse < bestValidationMse - config.minImprovement
      ) {
        bestValidationMse = validationMse;
        bestTrainingMse = trainingMse;
        bestTreeCount = trees.length;
        roundsWithoutImprovement = 0;
      } else {
        roundsWithoutImprovement++;
      }

      if (
        config.earlyStoppingRounds > 0 &&
        roundsWithoutImprovement >= config.earlyStoppingRounds
      ) {
        break;
      }
    }

    if (validation === undefined || config.earlyStoppingRounds === 0) {
      bestTreeCount = trees.length;
      bestTrainingMse = mse(targets, predictions, sampleWeights);
      if (validation !== undefined) {
        bestValidationMse = mse(
          validation.targets,
          validationPredictions!,
          validationWeights!,
        );
      }
    }
    const retainedTrees = trees.slice(0, bestTreeCount);
    const training: GradientBoostedTreesTrainingSummary = Object.freeze({
      requestedTrees: config.trees,
      attemptedTrees,
      fittedTrees: retainedTrees.length,
      stoppedEarly:
        attemptedTrees < config.trees || retainedTrees.length < attemptedTrees,
      trainMse: bestTrainingMse,
      ...(bestValidationMse === undefined
        ? {}
        : { validationMse: bestValidationMse }),
    });
    return new GradientBoostedTrees(
      featureCount,
      baseValue,
      config,
      training,
      retainedTrees,
    );
  }
}

export function fitGradientBoostedTrees(
  inputs: readonly (readonly number[])[],
  targets: readonly number[],
  options: GradientBoostedTreesOptions = {},
): GradientBoostedTrees {
  return GradientBoostedTrees.fit(inputs, targets, options);
}
