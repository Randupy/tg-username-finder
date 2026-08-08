/**
 * Dependency-free, time-aware liquidity estimation for username listings.
 *
 * The estimator uses a weighted Aalen-Johansen curve:
 * - sold listings are the event of interest;
 * - active listings are right-censored at the latest confirmed observation,
 *   capped by valuationAt;
 * - expired/cancelled listings are competing non-sale events.
 *
 * Every observation is reconstructed as it was known at valuationAt. A
 * future sale/end is therefore converted to an active right-censored row,
 * while a listing that starts in the future is ignored entirely.
 */

export type LiquidityTimestamp = string | number | Date;
export type LiquidityObservationId = string | number;
export type LiquidityListingStatus = "sold" | "active" | "expired" | "cancelled";
export type LiquidityEventType = "sale" | "competing" | "right-censored";

export interface LiquidityListingObservation {
  id?: LiquidityObservationId;
  listingId?: LiquidityObservationId;
  username: string;
  status: LiquidityListingStatus;
  /** Asking price known at listing time. Must be finite and positive. */
  askTon: number;
  listedAt: LiquidityTimestamp;
  /**
   * Latest time this same listing was confirmed to still exist. Supplying it
   * prevents a stale one-off listing event from inventing months of follow-up.
   * Direct callers may omit it when their status is known at valuationAt.
   */
  lastObservedAt?: LiquidityTimestamp;
  endedAt?: LiquidityTimestamp;
  soldAt?: LiquidityTimestamp;
  /** Optional realized price. For sold rows, askTon is the fallback. */
  salePriceTon?: number;
  /** Optional market-defined segment (e.g. dictionary, numeric, brand). */
  segment?: string;
  /** Optional precomputed similarity to the target, in [0, 1]. */
  similarity?: number;
}

export interface LiquidityTarget {
  username: string;
  /** Conditions liquidity and realized-price estimates on a target ask. */
  askTon?: number;
  /** Explicit market segment; otherwise a structural segment is inferred. */
  segment?: string;
}

export interface LiquidityEstimatorOptions {
  /** Cohort time-decay half-life based on listedAt. Default: 365 days. */
  recencyHalfLifeDays?: number;
  /** Concentrates weight on lexically close usernames. Default: 2. */
  similarityPower?: number;
  /** Rows below this target similarity are ignored. Default: 0.03. */
  minimumSimilarity?: number;
  /** Log-price bandwidth for conditioning on target ask. Default: 1. */
  askPriceBandwidthLog?: number;
  /** Weight for observations in a different segment. Default: 0.35. */
  crossSegmentWeight?: number;
  /** Maximum rows used in the curve. Default: 300. */
  maxObservations?: number;
  /** Number of highest-weight diagnostics returned. Default: 12. */
  topDiagnosticCount?: number;
  /** Effective sample threshold used for OOD reporting. Default: 4. */
  minimumEffectiveSampleSize?: number;
  /** Best-match threshold used for OOD reporting. Default: 0.4. */
  minimumBestSimilarity?: number;
  /** Weighted-average similarity OOD threshold. Default: 0.22. */
  minimumAverageSimilarity?: number;
  /** Listing ids excluded from a historical/backtest valuation. */
  excludeObservationIds?: readonly LiquidityObservationId[];
}

export interface LiquidityObservationDiagnostic {
  id?: string;
  username: string;
  segment: string;
  status: LiquidityListingStatus;
  eventType: LiquidityEventType;
  askTon: number;
  listedAt: string;
  observedThrough: string;
  durationDays: number;
  similarity: number;
  segmentWeight: number;
  askWeight: number;
  recencyWeight: number;
  /** Normalized influence among every selected observation. */
  weight: number;
  realizedSalePriceTon?: number;
}

export interface LiquidityEstimate {
  username: string;
  targetAskTon: number | null;
  targetSegment: string;
  valuationAt: string;
  saleProbability30d: number;
  saleProbability90d: number;
  saleProbability365d: number;
  /** First observed duration where sale cumulative incidence reaches 50%. */
  medianDaysToSale: number | null;
  /** Conditional realized sale price, not probability-adjusted proceeds. */
  expectedSalePriceTon: number | null;
  confidence: number;
  outOfDistribution: boolean;
  oodReasons: string[];
  effectiveSampleSize: number;
  eligibleObservationCount: number;
  usedObservationCount: number;
  soldObservationCount: number;
  rightCensoredObservationCount: number;
  competingObservationCount: number;
  weightedAverageSimilarity: number;
  bestSimilarity: number;
  followupSupport90d: number;
  followupSupport365d: number;
  topDiagnostics: LiquidityObservationDiagnostic[];
}

interface NormalizedObservation {
  id?: string;
  username: string;
  segment: string;
  status: LiquidityListingStatus;
  eventType: LiquidityEventType;
  askTon: number;
  listedAtMs: number;
  observedThroughMs: number;
  durationDays: number;
  realizedSalePriceTon?: number;
  providedSimilarity?: number;
}

interface WeightedObservation extends NormalizedObservation {
  similarity: number;
  segmentWeight: number;
  askWeight: number;
  recencyWeight: number;
  baseWeight: number;
}

interface CurvePoint {
  durationDays: number;
  cumulativeSaleProbability: number;
}

const DAY_MS = 86_400_000;
const MAX_SAFE_LOG = Math.log(Number.MAX_VALUE) - 2;

const DEFAULTS = {
  recencyHalfLifeDays: 365,
  similarityPower: 2,
  minimumSimilarity: 0.03,
  askPriceBandwidthLog: 1,
  crossSegmentWeight: 0.35,
  maxObservations: 300,
  topDiagnosticCount: 12,
  minimumEffectiveSampleSize: 4,
  minimumBestSimilarity: 0.4,
  minimumAverageSimilarity: 0.22,
} as const;

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeSegment(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function parseTimestamp(value: LiquidityTimestamp | undefined): number | null {
  if (value === undefined) return null;
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).getTime();
  return Number.isFinite(normalized) ? normalized : null;
}

function observationId(observation: LiquidityListingObservation): string | undefined {
  const raw = observation.id ?? observation.listingId;
  if (raw === undefined || raw === null) return undefined;
  const normalized = String(raw).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function finiteOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be a finite number in [${minimum}, ${maximum}].`);
  }
  return result;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return result;
}

function lengthBucket(length: number): string {
  if (length <= 4) return "4";
  if (length === 5) return "5";
  if (length <= 7) return "6-7";
  if (length <= 10) return "8-10";
  return "11+";
}

/** Deterministic structural fallback when no explicit market segment exists. */
export function inferLiquiditySegment(usernameRaw: string): string {
  const username = normalizeUsername(usernameRaw);
  const hasLetters = /[a-z]/.test(username);
  const hasDigits = /\d/.test(username);
  const hasUnderscore = username.includes("_");

  let shape = "other";
  if (hasLetters && !hasDigits && !hasUnderscore) shape = "letters";
  else if (!hasLetters && hasDigits && !hasUnderscore) shape = "digits";
  else if (hasLetters && hasDigits && !hasUnderscore) shape = "letter-digit";
  else if (hasUnderscore && (hasLetters || hasDigits)) shape = "underscore";
  else if (hasLetters || hasDigits) shape = "mixed";

  return `${shape}:${lengthBucket(username.length)}`;
}

function ngrams(value: string, size: number): Set<string> {
  const padded = `^${value}$`;
  if (padded.length <= size) return new Set([padded]);
  const result = new Set<string>();
  for (let index = 0; index <= padded.length - size; index++) {
    result.add(padded.slice(index, index + size));
  }
  return result;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return safeRatio(intersection, union);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array<number>(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitution,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

/**
 * Lightweight standalone lexical/structural similarity in [0, 1].
 * A caller with a richer embedding may provide observation.similarity.
 */
export function liquidityUsernameSimilarity(leftRaw: string, rightRaw: string): number {
  const left = normalizeUsername(leftRaw);
  const right = normalizeUsername(rightRaw);
  if (left === right) return left.length > 0 ? 1 : 0;
  if (left.length === 0 || right.length === 0) return 0;

  const bigrams = jaccard(ngrams(left, 2), ngrams(right, 2));
  const trigrams = jaccard(ngrams(left, 3), ngrams(right, 3));
  const edit =
    1 - levenshteinDistance(left, right) / Math.max(left.length, right.length, 1);
  const lengthSimilarity =
    1 - Math.abs(left.length - right.length) / Math.max(left.length, right.length, 1);
  const leftDigits = safeRatio((left.match(/\d/g) ?? []).length, left.length);
  const rightDigits = safeRatio((right.match(/\d/g) ?? []).length, right.length);
  const digitPenalty = Math.exp(-1.5 * Math.abs(leftDigits - rightDigits));
  const underscorePenalty = Math.exp(
    -0.35 *
      Math.abs(
        (left.match(/_/g) ?? []).length - (right.match(/_/g) ?? []).length,
      ),
  );

  const lexical = 0.42 * bigrams + 0.38 * trigrams + 0.2 * edit;
  return clamp(
    (0.92 * lexical + 0.08 * lengthSimilarity) * digitPenalty * underscorePenalty,
    0,
    1,
  );
}

function segmentCompatibility(
  targetSegment: string,
  observationSegment: string,
  crossSegmentWeight: number,
): number {
  if (targetSegment === observationSegment) return 1;
  const targetShape = targetSegment.split(":", 1)[0];
  const observationShape = observationSegment.split(":", 1)[0];
  if (targetShape === observationShape) return Math.sqrt(crossSegmentWeight);
  return crossSegmentWeight;
}

function effectiveStatusAt(
  observation: LiquidityListingObservation,
  listedAtMs: number,
  valuationAtMs: number,
): Pick<
  NormalizedObservation,
  "status" | "eventType" | "observedThroughMs" | "durationDays" | "realizedSalePriceTon"
> | null {
  const explicitLastObservedAtMs = parseTimestamp(observation.lastObservedAt);
  const rightCensorAtMs =
    explicitLastObservedAtMs === null
      ? valuationAtMs
      : Math.min(explicitLastObservedAtMs, valuationAtMs);
  const rightCensored = (): Pick<
    NormalizedObservation,
    "status" | "eventType" | "observedThroughMs" | "durationDays"
  > | null => {
    if (rightCensorAtMs < listedAtMs) return null;
    return {
      status: "active",
      eventType: "right-censored",
      observedThroughMs: rightCensorAtMs,
      durationDays: (rightCensorAtMs - listedAtMs) / DAY_MS,
    };
  };

  if (observation.status === "sold") {
    const soldAtMs = parseTimestamp(observation.soldAt);
    const endedAtMs = parseTimestamp(observation.endedAt);
    const eventAtMs = soldAtMs ?? endedAtMs;
    if (eventAtMs !== null && eventAtMs <= valuationAtMs) {
      if (eventAtMs < listedAtMs) return null;
      const explicitPrice =
        observation.salePriceTon !== undefined &&
        Number.isFinite(observation.salePriceTon) &&
        observation.salePriceTon > 0
          ? observation.salePriceTon
          : undefined;
      return {
        status: "sold",
        eventType: "sale",
        observedThroughMs: eventAtMs,
        durationDays: (eventAtMs - listedAtMs) / DAY_MS,
        realizedSalePriceTon: explicitPrice ?? observation.askTon,
      };
    }

    // A currently known future sale must look exactly like an active listing
    // in a historical valuation. Its future status and price are not exposed.
    return rightCensored();
  }

  if (observation.status === "expired" || observation.status === "cancelled") {
    const endedAtMs = parseTimestamp(observation.endedAt);
    if (endedAtMs !== null && endedAtMs <= valuationAtMs) {
      if (endedAtMs < listedAtMs) return null;
      return {
        status: observation.status,
        eventType: "competing",
        observedThroughMs: endedAtMs,
        durationDays: (endedAtMs - listedAtMs) / DAY_MS,
      };
    }

    return rightCensored();
  }

  if (observation.status !== "active") return null;
  return rightCensored();
}

function normalizeObservation(
  observation: LiquidityListingObservation,
  valuationAtMs: number,
  excludedIds: ReadonlySet<string>,
): NormalizedObservation | null {
  const username = normalizeUsername(observation.username);
  const id = observationId(observation);
  const listedAtMs = parseTimestamp(observation.listedAt);
  if (
    username.length === 0 ||
    listedAtMs === null ||
    listedAtMs > valuationAtMs ||
    !Number.isFinite(observation.askTon) ||
    observation.askTon <= 0 ||
    (id !== undefined && excludedIds.has(id))
  ) {
    return null;
  }

  const effective = effectiveStatusAt(observation, listedAtMs, valuationAtMs);
  if (effective === null || !Number.isFinite(effective.durationDays)) return null;

  const providedSimilarity =
    observation.similarity !== undefined &&
    Number.isFinite(observation.similarity) &&
    observation.similarity >= 0 &&
    observation.similarity <= 1
      ? observation.similarity
      : undefined;

  return {
    id,
    username,
    segment:
      normalizeSegment(observation.segment) ?? inferLiquiditySegment(username),
    askTon: observation.askTon,
    listedAtMs,
    providedSimilarity,
    ...effective,
  };
}

function eventPriority(eventType: LiquidityEventType): number {
  if (eventType === "sale") return 2;
  if (eventType === "competing") return 1;
  return 0;
}

function deduplicateObservations(
  observations: readonly NormalizedObservation[],
): NormalizedObservation[] {
  const ordered = [...observations].sort((left, right) => {
    const leftKey =
      left.id !== undefined
        ? `id:${left.id}`
        : `row:${left.username}\u0000${left.listedAtMs}\u0000${left.askTon}`;
    const rightKey =
      right.id !== undefined
        ? `id:${right.id}`
        : `row:${right.username}\u0000${right.listedAtMs}\u0000${right.askTon}`;
    return (
      compareText(leftKey, rightKey) ||
      eventPriority(right.eventType) - eventPriority(left.eventType) ||
      right.observedThroughMs - left.observedThroughMs ||
      (right.providedSimilarity ?? -1) - (left.providedSimilarity ?? -1) ||
      compareText(left.username, right.username) ||
      compareText(left.segment, right.segment) ||
      left.askTon - right.askTon ||
      (left.realizedSalePriceTon ?? 0) - (right.realizedSalePriceTon ?? 0) ||
      compareText(left.status, right.status)
    );
  });

  const result: NormalizedObservation[] = [];
  const seen = new Set<string>();
  for (const row of ordered) {
    const key =
      row.id !== undefined
        ? `id:${row.id}`
        : `row:${row.username}\u0000${row.listedAtMs}\u0000${row.askTon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function weightedRows(
  target: LiquidityTarget,
  targetSegment: string,
  rows: readonly NormalizedObservation[],
  valuationAtMs: number,
  options: {
    recencyHalfLifeDays: number;
    similarityPower: number;
    minimumSimilarity: number;
    askPriceBandwidthLog: number;
    crossSegmentWeight: number;
  },
): WeightedObservation[] {
  const targetAskTon = target.askTon;
  const targetUsername = normalizeUsername(target.username);
  const result: WeightedObservation[] = [];

  for (const row of rows) {
    const similarity =
      row.providedSimilarity ??
      liquidityUsernameSimilarity(targetUsername, row.username);
    if (similarity < options.minimumSimilarity) continue;

    const segmentWeight = segmentCompatibility(
      targetSegment,
      row.segment,
      options.crossSegmentWeight,
    );
    const askWeight =
      targetAskTon === undefined
        ? 1
        : Math.exp(
            Math.max(
              -30,
              -Math.abs(Math.log(row.askTon / targetAskTon)) /
                options.askPriceBandwidthLog,
            ),
          );
    const cohortAgeDays = Math.max(0, (valuationAtMs - row.listedAtMs) / DAY_MS);
    const recencyWeight = Math.exp(
      Math.max(
        -30,
        (-Math.LN2 * cohortAgeDays) / options.recencyHalfLifeDays,
      ),
    );
    const baseWeight = Math.max(
      Number.MIN_VALUE,
      Math.max(Number.EPSILON, similarity) ** options.similarityPower *
        segmentWeight *
        askWeight *
        recencyWeight,
    );

    result.push({
      ...row,
      similarity,
      segmentWeight,
      askWeight,
      recencyWeight,
      baseWeight,
    });
  }

  return result;
}

function effectiveSampleSize(weights: readonly number[]): number {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const sumSquares = weights.reduce((total, weight) => total + weight * weight, 0);
  return sum > 0 && sumSquares > 0 ? (sum * sum) / sumSquares : 0;
}

function buildSaleCurve(rows: readonly WeightedObservation[]): CurvePoint[] {
  const eventTimes = [
    ...new Set(
      rows
        .filter((row) => row.eventType !== "right-censored")
        .map((row) => row.durationDays),
    ),
  ].sort((left, right) => left - right);

  let eventFreeSurvival = 1;
  let cumulativeSaleProbability = 0;
  const curve: CurvePoint[] = [];

  for (const durationDays of eventTimes) {
    const riskWeight = rows
      .filter((row) => row.durationDays >= durationDays)
      .reduce((sum, row) => sum + row.baseWeight, 0);
    if (!(riskWeight > 0) || !Number.isFinite(riskWeight)) continue;

    const saleWeight = rows
      .filter(
        (row) =>
          row.eventType === "sale" && row.durationDays === durationDays,
      )
      .reduce((sum, row) => sum + row.baseWeight, 0);
    const competingWeight = rows
      .filter(
        (row) =>
          row.eventType === "competing" && row.durationDays === durationDays,
      )
      .reduce((sum, row) => sum + row.baseWeight, 0);

    const saleHazard = clamp(saleWeight / riskWeight, 0, 1);
    const competingHazard = clamp(
      competingWeight / riskWeight,
      0,
      1 - saleHazard,
    );
    cumulativeSaleProbability = clamp(
      cumulativeSaleProbability + eventFreeSurvival * saleHazard,
      0,
      1,
    );
    eventFreeSurvival = clamp(
      eventFreeSurvival * (1 - saleHazard - competingHazard),
      0,
      1,
    );
    curve.push({ durationDays, cumulativeSaleProbability });
  }

  return curve;
}

function probabilityAt(curve: readonly CurvePoint[], horizonDays: number): number {
  let probability = 0;
  for (const point of curve) {
    if (point.durationDays > horizonDays) break;
    probability = point.cumulativeSaleProbability;
  }
  return clamp(probability, 0, 1);
}

function weightedQuantile(
  values: readonly number[],
  weights: readonly number[],
  quantile: number,
): number {
  const points = values
    .map((value, index) => ({ value, weight: weights[index] ?? 0 }))
    .filter(
      (point) =>
        Number.isFinite(point.value) &&
        Number.isFinite(point.weight) &&
        point.weight > 0,
    )
    .sort((left, right) => left.value - right.value);
  if (points.length === 0) return 0;

  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  const target = clamp(quantile, 0, 1) * totalWeight;
  let cumulative = 0;
  for (const point of points) {
    cumulative += point.weight;
    if (cumulative >= target) return point.value;
  }
  return points[points.length - 1].value;
}

function safeExp(logValue: number): number {
  return Math.exp(clamp(logValue, -MAX_SAFE_LOG, MAX_SAFE_LOG));
}

function expectedSalePrice(
  rows: readonly WeightedObservation[],
  targetAskTon: number | undefined,
): number | null {
  const soldRows = rows.filter(
    (
      row,
    ): row is WeightedObservation & { realizedSalePriceTon: number } =>
      row.eventType === "sale" &&
      row.realizedSalePriceTon !== undefined &&
      Number.isFinite(row.realizedSalePriceTon) &&
      row.realizedSalePriceTon > 0,
  );
  if (soldRows.length === 0) return null;

  const projectedLogs = soldRows.map((row) => {
    if (targetAskTon !== undefined) {
      return (
        Math.log(targetAskTon) +
        Math.log(row.realizedSalePriceTon / row.askTon)
      );
    }
    return Math.log(row.realizedSalePriceTon);
  });
  const weights = soldRows.map((row) => row.baseWeight);
  const center = weightedQuantile(projectedLogs, weights, 0.5);
  const deviations = projectedLogs.map((value) => Math.abs(value - center));
  const mad = weightedQuantile(deviations, weights, 0.5);
  const scale = Math.max(0.15, 1.4826 * mad);
  const clippedLogs = projectedLogs.map((value) =>
    clamp(value, center - 3.5 * scale, center + 3.5 * scale),
  );
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(weightSum > 0)) return null;
  const weightedLogMean = clippedLogs.reduce(
    (sum, value, index) => sum + value * weights[index],
    0,
  ) / weightSum;
  const estimate = safeExp(weightedLogMean);
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}

function followupSupport(
  rows: readonly WeightedObservation[],
  horizonDays: number,
  weightSum: number,
): number {
  if (!(weightSum > 0)) return 0;
  const supportedWeight = rows
    .filter(
      (row) =>
        row.durationDays >= horizonDays ||
        row.eventType === "sale" ||
        row.eventType === "competing",
    )
    .reduce((sum, row) => sum + row.baseWeight, 0);
  return clamp(supportedWeight / weightSum, 0, 1);
}

function emptyEstimate(
  target: LiquidityTarget,
  targetSegment: string,
  valuationAtMs: number,
  eligibleObservationCount = 0,
): LiquidityEstimate {
  return {
    username: normalizeUsername(target.username),
    targetAskTon: target.askTon ?? null,
    targetSegment,
    valuationAt: new Date(valuationAtMs).toISOString(),
    saleProbability30d: 0,
    saleProbability90d: 0,
    saleProbability365d: 0,
    medianDaysToSale: null,
    expectedSalePriceTon: null,
    confidence: 0,
    outOfDistribution: true,
    oodReasons: ["no-observations"],
    effectiveSampleSize: 0,
    eligibleObservationCount,
    usedObservationCount: 0,
    soldObservationCount: 0,
    rightCensoredObservationCount: 0,
    competingObservationCount: 0,
    weightedAverageSimilarity: 0,
    bestSimilarity: 0,
    followupSupport90d: 0,
    followupSupport365d: 0,
    topDiagnostics: [],
  };
}

/**
 * Estimate time-to-sale liquidity as it was knowable at valuationAt.
 *
 * Numeric timestamps are Unix milliseconds. Invalid observations are ignored;
 * invalid target/options/valuationAt fail fast because they would invalidate
 * the whole estimate.
 */
export function estimateLiquidity(
  targetRaw: string | LiquidityTarget,
  observations: readonly LiquidityListingObservation[],
  valuationAt: LiquidityTimestamp,
  options: LiquidityEstimatorOptions = {},
): LiquidityEstimate {
  const target: LiquidityTarget =
    typeof targetRaw === "string" ? { username: targetRaw } : targetRaw;
  const targetUsername = normalizeUsername(target.username);
  const valuationAtMs = parseTimestamp(valuationAt);
  if (valuationAtMs === null) {
    throw new RangeError("valuationAt must be a valid date or Unix millisecond timestamp.");
  }
  if (
    target.askTon !== undefined &&
    (!Number.isFinite(target.askTon) || target.askTon <= 0)
  ) {
    throw new RangeError("target.askTon must be a finite positive number.");
  }

  const recencyHalfLifeDays = finiteOption(
    options.recencyHalfLifeDays,
    DEFAULTS.recencyHalfLifeDays,
    "recencyHalfLifeDays",
    Number.EPSILON,
  );
  const similarityPower = finiteOption(
    options.similarityPower,
    DEFAULTS.similarityPower,
    "similarityPower",
    Number.EPSILON,
    20,
  );
  const minimumSimilarity = finiteOption(
    options.minimumSimilarity,
    DEFAULTS.minimumSimilarity,
    "minimumSimilarity",
    0,
    1,
  );
  const askPriceBandwidthLog = finiteOption(
    options.askPriceBandwidthLog,
    DEFAULTS.askPriceBandwidthLog,
    "askPriceBandwidthLog",
    Number.EPSILON,
  );
  const crossSegmentWeight = finiteOption(
    options.crossSegmentWeight,
    DEFAULTS.crossSegmentWeight,
    "crossSegmentWeight",
    Number.EPSILON,
    1,
  );
  const maxObservations = integerOption(
    options.maxObservations,
    DEFAULTS.maxObservations,
    "maxObservations",
    1,
  );
  const topDiagnosticCount = integerOption(
    options.topDiagnosticCount,
    DEFAULTS.topDiagnosticCount,
    "topDiagnosticCount",
    0,
  );
  const minimumEffectiveSampleSize = finiteOption(
    options.minimumEffectiveSampleSize,
    DEFAULTS.minimumEffectiveSampleSize,
    "minimumEffectiveSampleSize",
    0,
  );
  const minimumBestSimilarity = finiteOption(
    options.minimumBestSimilarity,
    DEFAULTS.minimumBestSimilarity,
    "minimumBestSimilarity",
    0,
    1,
  );
  const minimumAverageSimilarity = finiteOption(
    options.minimumAverageSimilarity,
    DEFAULTS.minimumAverageSimilarity,
    "minimumAverageSimilarity",
    0,
    1,
  );

  const targetSegment =
    normalizeSegment(target.segment) ?? inferLiquiditySegment(targetUsername);
  if (targetUsername.length === 0) {
    return emptyEstimate(target, targetSegment, valuationAtMs);
  }

  const excludedIds = new Set(
    (options.excludeObservationIds ?? []).map((id) => String(id).trim()),
  );
  const normalized = deduplicateObservations(
    observations
      .map((observation) =>
        normalizeObservation(observation, valuationAtMs, excludedIds),
      )
      .filter((row): row is NormalizedObservation => row !== null),
  );
  const eligibleObservationCount = normalized.length;

  const candidates = weightedRows(
    { ...target, username: targetUsername },
    targetSegment,
    normalized,
    valuationAtMs,
    {
      recencyHalfLifeDays,
      similarityPower,
      minimumSimilarity,
      askPriceBandwidthLog,
      crossSegmentWeight,
    },
  );
  candidates.sort(
    (left, right) =>
      right.baseWeight - left.baseWeight ||
      right.similarity - left.similarity ||
      right.listedAtMs - left.listedAtMs ||
      compareText(left.username, right.username) ||
      compareText(left.id ?? "", right.id ?? "") ||
      left.askTon - right.askTon,
  );
  const selected = candidates.slice(0, maxObservations);
  if (selected.length === 0) {
    return emptyEstimate(
      { ...target, username: targetUsername },
      targetSegment,
      valuationAtMs,
      eligibleObservationCount,
    );
  }

  const curve = buildSaleCurve(selected);
  const probability30 = probabilityAt(curve, 30);
  const probability90 = Math.max(probability30, probabilityAt(curve, 90));
  const probability365 = Math.max(probability90, probabilityAt(curve, 365));
  const medianPoint = curve.find(
    (point) => point.cumulativeSaleProbability >= 0.5,
  );

  const weights = selected.map((row) => row.baseWeight);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const effectiveN = effectiveSampleSize(weights);
  const weightedAverageSimilarity =
    weightSum > 0
      ? selected.reduce(
          (sum, row) => sum + row.similarity * row.baseWeight,
          0,
        ) / weightSum
      : 0;
  const bestSimilarity = selected.reduce(
    (best, row) => Math.max(best, row.similarity),
    0,
  );
  const support90 = followupSupport(selected, 90, weightSum);
  const support365 = followupSupport(selected, 365, weightSum);
  const soldRows = selected.filter((row) => row.eventType === "sale");
  const competingRows = selected.filter((row) => row.eventType === "competing");
  const rightCensoredRows = selected.filter(
    (row) => row.eventType === "right-censored",
  );
  const eventWeightFraction =
    weightSum > 0
      ? selected
          .filter((row) => row.eventType !== "right-censored")
          .reduce((sum, row) => sum + row.baseWeight, 0) / weightSum
      : 0;
  const soldWeightFraction =
    weightSum > 0
      ? soldRows.reduce((sum, row) => sum + row.baseWeight, 0) / weightSum
      : 0;

  const sampleQuality = clamp(
    Math.log1p(effectiveN) /
      Math.log1p(Math.max(16, minimumEffectiveSampleSize)),
    0,
    1,
  );
  const similarityQuality = clamp(
    (weightedAverageSimilarity - 0.08) / 0.72,
    0,
    1,
  );
  const informationQuality = clamp(
    0.5 * support90 + 0.3 * eventWeightFraction + 0.2 * soldWeightFraction,
    0,
    1,
  );
  const confidence = clamp(
    sampleQuality * (0.6 * similarityQuality + 0.4 * informationQuality),
    0,
    1,
  );

  const oodReasons: string[] = [];
  if (selected.length < 3) oodReasons.push("too-few-observations");
  if (effectiveN < minimumEffectiveSampleSize) {
    oodReasons.push("low-effective-sample-size");
  }
  if (bestSimilarity < minimumBestSimilarity) {
    oodReasons.push("no-close-match");
  }
  if (weightedAverageSimilarity < minimumAverageSimilarity) {
    oodReasons.push("low-average-similarity");
  }
  if (support90 < 0.3) oodReasons.push("insufficient-followup");
  if (soldRows.length === 0) oodReasons.push("no-observed-sales");

  if (target.askTon !== undefined) {
    const nearestAskDistance = selected.reduce(
      (nearest, row) =>
        Math.min(nearest, Math.abs(Math.log(row.askTon / target.askTon!))),
      Number.POSITIVE_INFINITY,
    );
    if (nearestAskDistance > 2 * askPriceBandwidthLog) {
      oodReasons.push("ask-price-out-of-range");
    }
  }
  if (confidence < 0.2) oodReasons.push("low-confidence");

  selected.sort(
    (left, right) =>
      right.baseWeight - left.baseWeight ||
      right.similarity - left.similarity ||
      right.listedAtMs - left.listedAtMs ||
      compareText(left.username, right.username) ||
      compareText(left.id ?? "", right.id ?? "") ||
      left.askTon - right.askTon,
  );
  const topDiagnostics = selected
    .slice(0, topDiagnosticCount)
    .map(
      (row): LiquidityObservationDiagnostic => ({
        ...(row.id === undefined ? {} : { id: row.id }),
        username: row.username,
        segment: row.segment,
        status: row.status,
        eventType: row.eventType,
        askTon: row.askTon,
        listedAt: new Date(row.listedAtMs).toISOString(),
        observedThrough: new Date(row.observedThroughMs).toISOString(),
        durationDays: row.durationDays,
        similarity: row.similarity,
        segmentWeight: row.segmentWeight,
        askWeight: row.askWeight,
        recencyWeight: row.recencyWeight,
        weight: weightSum > 0 ? row.baseWeight / weightSum : 0,
        ...(row.realizedSalePriceTon === undefined
          ? {}
          : { realizedSalePriceTon: row.realizedSalePriceTon }),
      }),
    );

  return {
    username: targetUsername,
    targetAskTon: target.askTon ?? null,
    targetSegment,
    valuationAt: new Date(valuationAtMs).toISOString(),
    saleProbability30d: probability30,
    saleProbability90d: probability90,
    saleProbability365d: probability365,
    medianDaysToSale: medianPoint?.durationDays ?? null,
    expectedSalePriceTon: expectedSalePrice(selected, target.askTon),
    confidence,
    outOfDistribution: oodReasons.length > 0,
    oodReasons,
    effectiveSampleSize: effectiveN,
    eligibleObservationCount,
    usedObservationCount: selected.length,
    soldObservationCount: soldRows.length,
    rightCensoredObservationCount: rightCensoredRows.length,
    competingObservationCount: competingRows.length,
    weightedAverageSimilarity,
    bestSimilarity,
    followupSupport90d: support90,
    followupSupport365d: support365,
    topDiagnostics,
  };
}

/** Explicitly named alias for callers that keep several liquidity estimators. */
export const estimateUsernameLiquidity = estimateLiquidity;
