export interface PriceAccuracyMetrics {
  count: number;
  rmsle: number;
  meanAbsoluteLogError: number;
  medianFactorError: number;
  within2x: number;
  within3x: number;
  spearman: number;
}

export interface PriceIntervalMetrics {
  count: number;
  coverage: number;
  meanWidthLog: number;
}

export interface PriceRankingMetrics {
  fraction: number;
  selected: number;
  recall: number;
}

const FACTOR_LOG_EPSILON = 1e-12;

function assertFiniteNonNegative(values: readonly number[], label: string): void {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${label} must contain only finite, non-negative values.`);
  }
}

export function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new RangeError("quantile requires at least one value.");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("quantile probability must be between 0 and 1.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start + 1;
    while (end < order.length && order[end].value === order[start].value) end++;
    const averageRank = (start + end - 1) / 2;
    for (let cursor = start; cursor < end; cursor++) ranks[order[cursor].index] = averageRank;
    start = end;
  }
  return ranks;
}

function pearson(left: readonly number[], right: readonly number[]): number {
  if (left.length < 2 || right.length !== left.length) return 0;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index++) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : 0;
}

export function evaluatePricePredictions(
  actual: readonly number[],
  predicted: readonly number[],
): PriceAccuracyMetrics {
  if (actual.length === 0 || predicted.length !== actual.length) {
    throw new RangeError("actual and predicted must have the same non-zero length.");
  }
  assertFiniteNonNegative(actual, "actual");
  assertFiniteNonNegative(predicted, "predicted");

  const absoluteLogErrors = actual.map((value, index) =>
    Math.abs(Math.log1p(predicted[index]) - Math.log1p(value)),
  );
  const squaredLogErrors = absoluteLogErrors.map((value) => value * value);
  const absoluteLogRatios = actual.map((value, index) =>
    value > 0 && predicted[index] > 0
      ? Math.abs(Math.log(value) - Math.log(predicted[index]))
      : value === predicted[index]
        ? 0
        : Number.POSITIVE_INFINITY,
  );
  const factorErrors = absoluteLogRatios.map((value) => Math.exp(value));

  return {
    count: actual.length,
    rmsle: Math.sqrt(squaredLogErrors.reduce((sum, value) => sum + value, 0) / actual.length),
    meanAbsoluteLogError:
      absoluteLogErrors.reduce((sum, value) => sum + value, 0) / actual.length,
    medianFactorError: quantile(factorErrors, 0.5),
    within2x:
      absoluteLogRatios.filter((value) => value <= Math.log(2) + FACTOR_LOG_EPSILON)
        .length / actual.length,
    within3x:
      absoluteLogRatios.filter((value) => value <= Math.log(3) + FACTOR_LOG_EPSILON)
        .length / actual.length,
    spearman: pearson(averageRanks(actual), averageRanks(predicted)),
  };
}

/** True multiplicative price error; unlike RMSLE it never adds one TON. */
export function multiplicativeFactorError(actual: number, predicted: number): number {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(predicted) ||
    actual < 0 ||
    predicted < 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  if (actual === 0 || predicted === 0) return actual === predicted ? 1 : Number.POSITIVE_INFINITY;
  return Math.exp(Math.abs(Math.log(actual) - Math.log(predicted)));
}

export function isWithinPriceFactor(
  actual: number,
  predicted: number,
  factor: number,
): boolean {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(predicted) ||
    !Number.isFinite(factor) ||
    actual < 0 ||
    predicted < 0 ||
    factor < 1
  ) {
    return false;
  }
  if (actual === 0 || predicted === 0) return actual === predicted;
  return (
    Math.abs(Math.log(actual) - Math.log(predicted)) <=
    Math.log(factor) + FACTOR_LOG_EPSILON
  );
}

export function evaluatePriceIntervals(
  actual: readonly number[],
  lower: readonly number[],
  upper: readonly number[],
): PriceIntervalMetrics {
  if (
    actual.length === 0 ||
    lower.length !== actual.length ||
    upper.length !== actual.length
  ) {
    throw new RangeError("actual, lower and upper must have the same non-zero length.");
  }
  assertFiniteNonNegative(actual, "actual");
  assertFiniteNonNegative(lower, "lower");
  assertFiniteNonNegative(upper, "upper");
  let covered = 0;
  let widthLog = 0;
  for (let index = 0; index < actual.length; index++) {
    if (lower[index] > upper[index]) throw new RangeError("lower interval bound exceeds upper.");
    if (actual[index] >= lower[index] && actual[index] <= upper[index]) covered++;
    widthLog += Math.log1p(upper[index]) - Math.log1p(lower[index]);
  }
  return {
    count: actual.length,
    coverage: covered / actual.length,
    meanWidthLog: widthLog / actual.length,
  };
}

export function evaluateTopTailRecall(
  actual: readonly number[],
  predicted: readonly number[],
  fraction = 0.05,
): PriceRankingMetrics {
  if (actual.length === 0 || actual.length !== predicted.length) {
    throw new RangeError("actual and predicted must have the same non-zero length.");
  }
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new RangeError("fraction must be greater than 0 and at most 1.");
  }
  assertFiniteNonNegative(actual, "actual");
  assertFiniteNonNegative(predicted, "predicted");
  const selected = Math.max(1, Math.ceil(actual.length * fraction));

  // At a cutoff tie, distribute the remaining m slots uniformly across the t
  // tied rows, so each row has membership weight m / t. Applying this to both
  // rankings makes sum(actualWeight[i] * predictedWeight[i]) the expected
  // overlap under independent uniform tie-breaking, with exactly `selected`
  // total weight on each side. It is therefore invariant to input row order.
  const fractionalTopMembership = (values: readonly number[]): number[] => {
    const sorted = [...values].sort((left, right) => right - left);
    const cutoff = sorted[selected - 1];
    let aboveCutoff = 0;
    let atCutoff = 0;
    for (const value of values) {
      if (value > cutoff) aboveCutoff++;
      else if (value === cutoff) atCutoff++;
    }
    const cutoffWeight = (selected - aboveCutoff) / atCutoff;
    return values.map((value) =>
      value > cutoff ? 1 : value === cutoff ? cutoffWeight : 0,
    );
  };

  const actualMembership = fractionalTopMembership(actual);
  const predictedMembership = fractionalTopMembership(predicted);
  const expectedHits = actualMembership.reduce(
    (sum, weight, index) => sum + weight * predictedMembership[index],
    0,
  );
  return { fraction, selected, recall: expectedHits / selected };
}

export function priceFromLog(logPrice: number): number {
  if (!Number.isFinite(logPrice)) return 0;
  // Avoid Infinity in corrupted/out-of-distribution model output while keeping
  // the cap well above any plausible Fragment transaction.
  return Math.max(0, Math.expm1(Math.min(logPrice, Math.log1p(1_000_000_000_000))));
}
