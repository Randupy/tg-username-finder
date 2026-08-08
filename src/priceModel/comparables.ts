/**
 * A dependency-free comparable-sales estimator.
 *
 * The estimator is deliberately time-aware: records without a usable
 * timestamp are ignored and records after `valuationAt` are never considered.
 * This makes the same function suitable for both live estimates and
 * walk-forward backtests.
 */

export type ComparableTimestamp = string | number | Date;
export type ComparableEventId = string | number;
export type ComparableTimestampEvidence = "exact" | "observed";

/**
 * Increment whenever selection, weighting, timestamp semantics, or a pinned
 * production option changes. Model artifacts bind to this pipeline.
 */
export const COMPARABLE_PIPELINE_VERSION = 1;
export const COMPARABLE_PIPELINE_SIGNATURE = JSON.stringify({
  version: COMPARABLE_PIPELINE_VERSION,
  eventTime: "strictly-before",
  eventConflictPolicy: "exclude-all-conflicting-occurrences",
  options: {
    recencyHalfLifeDays: 540,
    maxComparables: 80,
    topComparableCount: 12,
    minimumSimilarity: 0.05,
    similarityPower: 3,
    outlierClipZ: 3.5,
    minimumLogScale: 0.3,
    maxPriceAdjustmentFactor: 2.25,
    minimumEffectiveSampleSize: 3,
    minimumBestSimilarity: 0.42,
    minimumAverageSimilarity: 0.25,
    observedTimestampWeight: 0.35,
  },
});

/**
 * Compatible with the project's current SoldRecord while allowing richer
 * on-chain records to provide a true sale timestamp and stable event id.
 */
export interface ComparableSaleRecord {
  username: string;
  priceTon: number;
  /** Exact sale time from the source/chain. Highest-precedence timestamp. */
  saleAt?: ComparableTimestamp;
  soldAt?: ComparableTimestamp;
  eventAt?: ComparableTimestamp;
  timestamp?: ComparableTimestamp;
  scrapedAt?: ComparableTimestamp;
  eventId?: ComparableEventId;
  id?: ComparableEventId;
  txHash?: string;
}

export interface ComparableEstimatorOptions {
  /** Event being valued in a backtest; it must not compare against itself. */
  excludeEventId?: ComparableEventId;
  /** Additional duplicate/target events to exclude. */
  excludeEventIds?: readonly ComparableEventId[];
  /** Exponential time-decay half-life. Default: 540 days. */
  recencyHalfLifeDays?: number;
  /** Maximum number of rows participating in the estimate. Default: 80. */
  maxComparables?: number;
  /** Number of diagnostic rows returned to the caller. Default: 12. */
  topComparableCount?: number;
  /** Ignore lexically unrelated rows below this score. Default: 0.05. */
  minimumSimilarity?: number;
  /** Concentrates weight on the closest names. Default: 3. */
  similarityPower?: number;
  /** Robust log-price winsorization threshold. Default: 3.5 scales. */
  outlierClipZ?: number;
  /** Lower bound for the robust log-price scale. Default: 0.3. */
  minimumLogScale?: number;
  /** Caps the heuristic structural price adjustment. Default: 2.25x. */
  maxPriceAdjustmentFactor?: number;
  /** Effective sample size below which the estimate is OOD. Default: 3. */
  minimumEffectiveSampleSize?: number;
  /** Best-match score below which the estimate is OOD. Default: 0.42. */
  minimumBestSimilarity?: number;
  /** Weighted mean similarity below which the estimate is OOD. Default: 0.25. */
  minimumAverageSimilarity?: number;
  /** Weight multiplier for observation-only timestamps. Default: 0.35. */
  observedTimestampWeight?: number;
}

export interface ComparableRow {
  username: string;
  eventId?: string;
  soldAt: string;
  /** Exact sale time or a lower-quality observation-time fallback. */
  timestampEvidence: ComparableTimestampEvidence;
  priceTon: number;
  /** Price translated to the target's length/digit/segment structure. */
  adjustedPriceTon: number;
  /** Adjusted price after robust clipping; this is used in the quantiles. */
  robustAdjustedPriceTon: number;
  priceAdjustmentFactor: number;
  similarity: number;
  ngramSimilarity: number;
  editSimilarity: number;
  structuralPenalty: number;
  segmentPenalty: number;
  ageDays: number;
  recencyWeight: number;
  /** Normalized final influence after similarity, recency and robust weighting. */
  weight: number;
}

export interface ComparableEstimate {
  username: string;
  valuationAt: string;
  p10Ton: number;
  p50Ton: number;
  p90Ton: number;
  /** Unit interval. Zero means no usable market evidence. */
  confidence: number;
  outOfDistribution: boolean;
  oodReasons: string[];
  effectiveSampleSize: number;
  /** Valid, non-future, non-self, de-duplicated records before similarity cutoff. */
  eligibleRecordCount: number;
  /** Rows that participated in the robust estimate. */
  comparableCount: number;
  exactComparableCount: number;
  observedComparableCount: number;
  /** Weighted exact-time share, adjusted by the observed-time penalty. */
  timestampEvidenceQuality: number;
  /** Unique stable IDs excluded because their immutable occurrence data conflicted. */
  conflictingEventIdCount: number;
  topComparables: ComparableRow[];
}

interface NameStructure {
  length: number;
  digitRatio: number;
  underscoreCount: number;
  classRuns: string;
  segments: Array<{ type: string; length: number }>;
}

interface SimilarityBreakdown {
  similarity: number;
  ngramSimilarity: number;
  editSimilarity: number;
  structuralPenalty: number;
  segmentPenalty: number;
}

interface Candidate {
  username: string;
  eventId?: string;
  soldAtMs: number;
  timestampEvidence: ComparableTimestampEvidence;
  priceTon: number;
  adjustedPriceTon: number;
  adjustedLogPrice: number;
  priceAdjustmentFactor: number;
  similarity: number;
  ngramSimilarity: number;
  editSimilarity: number;
  structuralPenalty: number;
  segmentPenalty: number;
  ageDays: number;
  recencyWeight: number;
  baseWeight: number;
  selectionScore: number;
  robustAdjustedLogPrice: number;
  robustWeight: number;
  finalWeight: number;
}

const DAY_MS = 86_400_000;
const MAX_LOG_PRICE = Math.log(Number.MAX_VALUE) - 2;

const DEFAULTS = {
  recencyHalfLifeDays: 540,
  maxComparables: 80,
  topComparableCount: 12,
  minimumSimilarity: 0.05,
  similarityPower: 3,
  outlierClipZ: 3.5,
  minimumLogScale: 0.3,
  maxPriceAdjustmentFactor: 2.25,
  minimumEffectiveSampleSize: 3,
  minimumBestSimilarity: 0.42,
  minimumAverageSimilarity: 0.25,
  observedTimestampWeight: 0.35,
} as const;

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function eventIdOf(record: ComparableSaleRecord): string | undefined {
  const value = record.eventId ?? record.id ?? record.txHash;
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseTimestamp(value: ComparableTimestamp | undefined): number | null {
  if (value === undefined) return null;
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).getTime();
  return Number.isFinite(normalized) ? normalized : null;
}

function timestampOf(
  record: ComparableSaleRecord,
): { time: number; evidence: ComparableTimestampEvidence } | null {
  for (const candidate of [record.saleAt, record.soldAt, record.eventAt, record.timestamp]) {
    const parsed = parseTimestamp(candidate);
    if (parsed !== null) return { time: parsed, evidence: "exact" };
  }
  const observed = parseTimestamp(record.scrapedAt);
  return observed === null ? null : { time: observed, evidence: "observed" };
}

function charClass(char: string): string {
  if (char >= "a" && char <= "z") return "a";
  if (char >= "0" && char <= "9") return "d";
  if (char === "_") return "_";
  return "o";
}

function structureOf(username: string): NameStructure {
  let digits = 0;
  let underscores = 0;
  let classRuns = "";
  const segments: Array<{ type: string; length: number }> = [];
  let currentType = "";
  let currentLength = 0;

  const flushSegment = (): void => {
    if (currentLength > 0) {
      segments.push({ type: currentType, length: currentLength });
      currentType = "";
      currentLength = 0;
    }
  };

  for (const char of username) {
    const type = charClass(char);
    if (type === "d") digits++;
    if (type === "_") underscores++;
    if (classRuns[classRuns.length - 1] !== type) classRuns += type;

    if (type === "_") {
      flushSegment();
    } else if (type === currentType) {
      currentLength++;
    } else {
      flushSegment();
      currentType = type;
      currentLength = 1;
    }
  }
  flushSegment();

  return {
    length: username.length,
    digitRatio: username.length > 0 ? digits / username.length : 0,
    underscoreCount: underscores,
    classRuns,
    segments,
  };
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

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
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

function normalizedEditSimilarity(left: string, right: string): number {
  const denominator = Math.max(left.length, right.length);
  return denominator === 0 ? 1 : 1 - levenshteinDistance(left, right) / denominator;
}

function segmentPenalty(left: NameStructure, right: NameStructure): number {
  const count = Math.max(left.segments.length, right.segments.length, 1);
  let profileDistance = Math.abs(left.segments.length - right.segments.length) / count;
  const aligned = Math.min(left.segments.length, right.segments.length);

  for (let index = 0; index < aligned; index++) {
    const leftSegment = left.segments[index];
    const rightSegment = right.segments[index];
    if (leftSegment.type !== rightSegment.type) profileDistance += 1 / count;
    profileDistance +=
      Math.abs(leftSegment.length - rightSegment.length) /
      Math.max(leftSegment.length, rightSegment.length, 1) /
      count;
  }

  return Math.exp(-0.9 * profileDistance);
}

function similarityBreakdown(leftRaw: string, rightRaw: string): SimilarityBreakdown {
  const left = normalizeUsername(leftRaw);
  const right = normalizeUsername(rightRaw);
  if (left === right) {
    return {
      similarity: 1,
      ngramSimilarity: 1,
      editSimilarity: 1,
      structuralPenalty: 1,
      segmentPenalty: 1,
    };
  }
  if (left.length === 0 || right.length === 0) {
    return {
      similarity: 0,
      ngramSimilarity: 0,
      editSimilarity: 0,
      structuralPenalty: 0,
      segmentPenalty: 0,
    };
  }

  const bigramSimilarity = jaccard(ngrams(left, 2), ngrams(right, 2));
  const trigramSimilarity = jaccard(ngrams(left, 3), ngrams(right, 3));
  const ngramSimilarity = 0.45 * bigramSimilarity + 0.55 * trigramSimilarity;
  const editSimilarity = normalizedEditSimilarity(left, right);

  const leftStructure = structureOf(left);
  const rightStructure = structureOf(right);
  const lengthDistance =
    Math.abs(leftStructure.length - rightStructure.length) /
    Math.max(leftStructure.length, rightStructure.length, 1);
  const digitDistance = Math.abs(leftStructure.digitRatio - rightStructure.digitRatio);
  const underscoreDistance = Math.abs(
    leftStructure.underscoreCount - rightStructure.underscoreCount,
  );
  const classRunSimilarity = normalizedEditSimilarity(
    leftStructure.classRuns,
    rightStructure.classRuns,
  );
  const structuralPenalty =
    Math.exp(-1.25 * lengthDistance - 1.4 * digitDistance - 0.3 * underscoreDistance) *
    (0.65 + 0.35 * classRunSimilarity);
  const segments = segmentPenalty(leftStructure, rightStructure);

  const lexicalSimilarity = 0.58 * ngramSimilarity + 0.42 * editSimilarity;
  // A small structural term provides a low-confidence fallback for same-shape
  // names with no shared n-grams. Multiplicative penalties prevent that
  // fallback from treating different digit/underscore layouts as comparable.
  const similarity = clamp(
    (0.94 * lexicalSimilarity + 0.06 * structuralPenalty) *
      structuralPenalty *
      segments,
    0,
    1,
  );

  return {
    similarity,
    ngramSimilarity,
    editSimilarity,
    structuralPenalty,
    segmentPenalty: segments,
  };
}

/** Deterministic unit-interval similarity used by the estimator. */
export function usernameSimilarity(left: string, right: string): number {
  return similarityBreakdown(left, right).similarity;
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

function safeExp(logValue: number): number {
  return Math.exp(clamp(logValue, -MAX_LOG_PRICE, MAX_LOG_PRICE));
}

function structuralPriceAdjustment(
  comparable: NameStructure,
  target: NameStructure,
  maxFactor: number,
): number {
  // Directional but intentionally conservative: shorter, digit-free and
  // simpler targets receive a modest uplift relative to a weaker comparable.
  const logAdjustment =
    0.1 * (comparable.length - target.length) +
    0.4 * (comparable.digitRatio - target.digitRatio) +
    0.1 * (comparable.underscoreCount - target.underscoreCount) +
    0.06 * (comparable.segments.length - target.segments.length);
  const limit = Math.log(maxFactor);
  return Math.exp(clamp(logAdjustment, -limit, limit));
}

function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number {
  if (values.length === 0 || values.length !== weights.length) return 0;
  const points = values
    .map((value, index) => ({ value, weight: weights[index] }))
    .filter(
      (point) =>
        Number.isFinite(point.value) && Number.isFinite(point.weight) && point.weight > 0,
    )
    .sort((left, right) => left.value - right.value);
  if (points.length === 0) return 0;

  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return points[0].value;

  const target = clamp(q, 0, 1);
  let cumulative = 0;
  let previousPosition = 0;
  let previousValue = points[0].value;

  for (const point of points) {
    const position = (cumulative + point.weight / 2) / totalWeight;
    if (target <= position) {
      if (position <= previousPosition) return point.value;
      const fraction = clamp((target - previousPosition) / (position - previousPosition), 0, 1);
      return previousValue + fraction * (point.value - previousValue);
    }
    cumulative += point.weight;
    previousPosition = position;
    previousValue = point.value;
  }
  return points[points.length - 1].value;
}

function effectiveSampleSize(weights: readonly number[]): number {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const sumSquares = weights.reduce((total, weight) => total + weight * weight, 0);
  if (!(sum > 0) || !(sumSquares > 0)) return 0;
  return (sum * sum) / sumSquares;
}

function emptyEstimate(
  username: string,
  valuationAtMs: number,
  eligibleRecordCount = 0,
  conflictingEventIdCount = 0,
): ComparableEstimate {
  const oodReasons = ["no-comparables"];
  if (conflictingEventIdCount > 0) oodReasons.push("conflicting-event-id-evidence");
  return {
    username,
    valuationAt: new Date(valuationAtMs).toISOString(),
    p10Ton: 0,
    p50Ton: 0,
    p90Ton: 0,
    confidence: 0,
    outOfDistribution: true,
    oodReasons,
    effectiveSampleSize: 0,
    eligibleRecordCount,
    comparableCount: 0,
    exactComparableCount: 0,
    observedComparableCount: 0,
    timestampEvidenceQuality: 0,
    conflictingEventIdCount,
    topComparables: [],
  };
}

/**
 * Estimate a username's market value from historical comparable sales.
 *
 * Numeric timestamps are interpreted as Unix milliseconds. A record must have
 * at least one parseable timestamp field; exact `saleAt` has highest
 * precedence and `scrapedAt` is the legacy compatibility fallback.
 */
export function estimateComparablePrice(
  usernameRaw: string,
  history: readonly ComparableSaleRecord[],
  valuationAt: ComparableTimestamp,
  options: ComparableEstimatorOptions = {},
): ComparableEstimate {
  const username = normalizeUsername(usernameRaw);
  const valuationAtMs = parseTimestamp(valuationAt);
  if (valuationAtMs === null) {
    throw new RangeError("valuationAt must be a valid date or Unix millisecond timestamp.");
  }

  const recencyHalfLifeDays = finiteOption(
    options.recencyHalfLifeDays,
    DEFAULTS.recencyHalfLifeDays,
    "recencyHalfLifeDays",
    Number.EPSILON,
  );
  const maxComparables = integerOption(
    options.maxComparables,
    DEFAULTS.maxComparables,
    "maxComparables",
    1,
  );
  const topComparableCount = integerOption(
    options.topComparableCount,
    DEFAULTS.topComparableCount,
    "topComparableCount",
    0,
  );
  const minimumSimilarity = finiteOption(
    options.minimumSimilarity,
    DEFAULTS.minimumSimilarity,
    "minimumSimilarity",
    0,
    1,
  );
  const similarityPower = finiteOption(
    options.similarityPower,
    DEFAULTS.similarityPower,
    "similarityPower",
    Number.EPSILON,
  );
  const outlierClipZ = finiteOption(
    options.outlierClipZ,
    DEFAULTS.outlierClipZ,
    "outlierClipZ",
    Number.EPSILON,
  );
  const minimumLogScale = finiteOption(
    options.minimumLogScale,
    DEFAULTS.minimumLogScale,
    "minimumLogScale",
    Number.EPSILON,
  );
  const maxPriceAdjustmentFactor = finiteOption(
    options.maxPriceAdjustmentFactor,
    DEFAULTS.maxPriceAdjustmentFactor,
    "maxPriceAdjustmentFactor",
    1,
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
  const observedTimestampWeight = finiteOption(
    options.observedTimestampWeight,
    DEFAULTS.observedTimestampWeight,
    "observedTimestampWeight",
    0,
    1,
  );

  if (username.length === 0) return emptyEstimate(username, valuationAtMs);

  const excludedIds = new Set(
    [options.excludeEventId, ...(options.excludeEventIds ?? [])]
      .filter((value): value is ComparableEventId => value !== undefined && value !== null)
      .map((value) => String(value).trim()),
  );
  const targetStructure = structureOf(username);

  const rawRows = history
    .map((record) => {
      const candidateUsername = normalizeUsername(record.username);
      const timestamp = timestampOf(record);
      const eventId = eventIdOf(record);
      if (
        candidateUsername.length === 0 ||
        timestamp === null ||
        // A valuation at the event timestamp is pre-event. Same-time evidence
        // is therefore not yet observable and must not enter a backtest.
        timestamp.time >= valuationAtMs ||
        !Number.isFinite(record.priceTon) ||
        record.priceTon <= 0 ||
        (eventId !== undefined && excludedIds.has(eventId))
      ) {
        return null;
      }
      return {
        username: candidateUsername,
        soldAtMs: timestamp.time,
        timestampEvidence: timestamp.evidence,
        eventId,
        priceTon: record.priceTon,
      };
    })
    .filter(
      (
        row,
      ): row is {
        username: string;
        soldAtMs: number;
        timestampEvidence: ComparableTimestampEvidence;
        eventId: string | undefined;
        priceTon: number;
      } =>
        row !== null,
    )
    // Canonical order makes duplicate resolution independent of input order.
    .sort(
      (left, right) =>
        left.soldAtMs - right.soldAtMs ||
        (left.timestampEvidence === right.timestampEvidence
          ? 0
          : left.timestampEvidence === "exact"
            ? -1
            : 1) ||
        compareText(left.username, right.username) ||
        left.priceTon - right.priceTon ||
        compareText(left.eventId ?? "", right.eventId ?? ""),
    );

  const eventOccurrence = new Map<string, string>();
  const conflictingEventIds = new Set<string>();
  for (const row of rawRows) {
    if (row.eventId === undefined) continue;
    const occurrence = JSON.stringify([row.username, row.soldAtMs, row.priceTon]);
    const previous = eventOccurrence.get(row.eventId);
    if (previous !== undefined && previous !== occurrence) {
      conflictingEventIds.add(row.eventId);
    } else if (previous === undefined) {
      eventOccurrence.set(row.eventId, occurrence);
    }
  }

  const deduplicated: typeof rawRows = [];
  const seen = new Set<string>();
  for (const row of rawRows) {
    if (row.eventId !== undefined && conflictingEventIds.has(row.eventId)) continue;
    const key =
      row.eventId !== undefined
        ? `event:${row.eventId}`
        : `row:${row.username}\u0000${row.soldAtMs}\u0000${row.priceTon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(row);
  }

  const eligibleRecordCount = deduplicated.length;
  const candidates: Candidate[] = [];
  for (const row of deduplicated) {
    const similarity = similarityBreakdown(username, row.username);
    if (similarity.similarity < minimumSimilarity) continue;

    const ageDays = Math.max(0, (valuationAtMs - row.soldAtMs) / DAY_MS);
    // Clamp the exponent so even an ancient but excellent match retains a
    // representable (though negligible) weight.
    const recencyExponent = Math.max(
      -30,
      (-Math.LN2 * ageDays) / recencyHalfLifeDays,
    );
    const recencyWeight = Math.exp(recencyExponent);
    const priceAdjustmentFactor = structuralPriceAdjustment(
      structureOf(row.username),
      targetStructure,
      maxPriceAdjustmentFactor,
    );
    const adjustedLogPrice = clamp(
      Math.log(row.priceTon) + Math.log(priceAdjustmentFactor),
      -MAX_LOG_PRICE,
      MAX_LOG_PRICE,
    );
    const adjustedPriceTon = safeExp(adjustedLogPrice);
    const timestampWeight =
      row.timestampEvidence === "exact" ? 1 : observedTimestampWeight;
    const baseWeight =
      Math.max(Number.EPSILON, similarity.similarity) ** similarityPower *
      recencyWeight *
      timestampWeight;

    candidates.push({
      ...row,
      adjustedPriceTon,
      adjustedLogPrice,
      priceAdjustmentFactor,
      ...similarity,
      ageDays,
      recencyWeight,
      baseWeight,
      selectionScore: baseWeight,
      robustAdjustedLogPrice: adjustedLogPrice,
      robustWeight: 1,
      finalWeight: baseWeight,
    });
  }

  candidates.sort(
    (left, right) =>
      right.selectionScore - left.selectionScore ||
      right.similarity - left.similarity ||
      left.ageDays - right.ageDays ||
      compareText(left.username, right.username) ||
      left.soldAtMs - right.soldAtMs ||
      left.priceTon - right.priceTon ||
      compareText(left.eventId ?? "", right.eventId ?? ""),
  );
  const selected = candidates.slice(0, maxComparables);
  if (selected.length === 0) {
    return emptyEstimate(
      username,
      valuationAtMs,
      eligibleRecordCount,
      conflictingEventIds.size,
    );
  }

  const adjustedLogs = selected.map((candidate) => candidate.adjustedLogPrice);
  const baseWeights = selected.map((candidate) => candidate.baseWeight);
  const robustCenter = weightedQuantile(adjustedLogs, baseWeights, 0.5);
  const deviations = adjustedLogs.map((value) => Math.abs(value - robustCenter));
  const weightedMad = weightedQuantile(deviations, baseWeights, 0.5);
  const robustScale = Math.max(minimumLogScale, 1.4826 * weightedMad);
  const clipDistance = outlierClipZ * robustScale;

  for (const candidate of selected) {
    const residual = candidate.adjustedLogPrice - robustCenter;
    const absoluteZ = Math.abs(residual) / robustScale;
    // Redescending enough to neutralize isolated extreme prices while still
    // preserving genuine dispersion among similarly priced comparables.
    candidate.robustWeight =
      absoluteZ <= 2.5 ? 1 : (2.5 / absoluteZ) ** 2;
    candidate.robustAdjustedLogPrice = clamp(
      candidate.adjustedLogPrice,
      robustCenter - clipDistance,
      robustCenter + clipDistance,
    );
    candidate.finalWeight = Math.max(
      Number.MIN_VALUE,
      candidate.baseWeight * candidate.robustWeight,
    );
  }

  const finalWeights = selected.map((candidate) => candidate.finalWeight);
  const robustLogs = selected.map((candidate) => candidate.robustAdjustedLogPrice);
  const p10Ton = safeExp(weightedQuantile(robustLogs, finalWeights, 0.1));
  const p50Ton = safeExp(weightedQuantile(robustLogs, finalWeights, 0.5));
  const p90Ton = safeExp(weightedQuantile(robustLogs, finalWeights, 0.9));
  const effectiveN = effectiveSampleSize(finalWeights);
  const weightSum = finalWeights.reduce((sum, weight) => sum + weight, 0);
  const weightedAverageSimilarity =
    weightSum > 0
      ? selected.reduce(
          (sum, candidate) => sum + candidate.similarity * candidate.finalWeight,
          0,
        ) / weightSum
      : 0;
  const weightedAverageAge =
    weightSum > 0
      ? selected.reduce(
          (sum, candidate) => sum + candidate.ageDays * candidate.finalWeight,
          0,
        ) / weightSum
      : Number.POSITIVE_INFINITY;
  const exactComparableCount = selected.filter(
    (candidate) => candidate.timestampEvidence === "exact",
  ).length;
  const observedComparableCount = selected.length - exactComparableCount;
  const weightedExactShare =
    weightSum > 0
      ? selected.reduce(
          (sum, candidate) =>
            sum +
            (candidate.timestampEvidence === "exact" ? candidate.finalWeight : 0),
          0,
        ) / weightSum
      : 0;
  const timestampEvidenceQuality =
    observedTimestampWeight + (1 - observedTimestampWeight) * weightedExactShare;
  const bestSimilarity = selected.reduce(
    (best, candidate) => Math.max(best, candidate.similarity),
    0,
  );

  const sampleQuality = clamp(
    Math.log1p(effectiveN) / Math.log1p(Math.max(12, minimumEffectiveSampleSize)),
    0,
    1,
  );
  const similarityQuality = clamp((weightedAverageSimilarity - 0.1) / 0.65, 0, 1);
  const freshnessQuality = Number.isFinite(weightedAverageAge)
    ? Math.exp(-weightedAverageAge / (recencyHalfLifeDays * 2.5))
    : 0;
  const logSpread =
    p10Ton > 0 && p90Ton >= p10Ton ? Math.max(0, Math.log(p90Ton / p10Ton)) : 10;
  const dispersionQuality = 1 / (1 + logSpread / 2);
  const confidence = clamp(
    sampleQuality *
      (0.55 * similarityQuality + 0.25 * freshnessQuality + 0.2 * dispersionQuality) *
      timestampEvidenceQuality,
    0,
    1,
  );

  const oodReasons: string[] = [];
  if (selected.length < 3) oodReasons.push("too-few-comparables");
  if (effectiveN < minimumEffectiveSampleSize) {
    oodReasons.push("low-effective-sample-size");
  }
  if (bestSimilarity < minimumBestSimilarity) oodReasons.push("no-close-match");
  if (weightedAverageSimilarity < minimumAverageSimilarity) {
    oodReasons.push("low-average-similarity");
  }
  if (exactComparableCount === 0) oodReasons.push("observed-time-only");
  else if (weightedExactShare < 0.5) oodReasons.push("mostly-observed-times");
  if (conflictingEventIds.size > 0) oodReasons.push("conflicting-event-id-evidence");
  if (confidence < 0.25) oodReasons.push("low-confidence");

  selected.sort(
    (left, right) =>
      right.finalWeight - left.finalWeight ||
      right.similarity - left.similarity ||
      left.ageDays - right.ageDays ||
      compareText(left.username, right.username) ||
      left.soldAtMs - right.soldAtMs ||
      left.priceTon - right.priceTon ||
      compareText(left.eventId ?? "", right.eventId ?? ""),
  );

  const topComparables = selected.slice(0, topComparableCount).map(
    (candidate): ComparableRow => ({
      username: candidate.username,
      ...(candidate.eventId === undefined ? {} : { eventId: candidate.eventId }),
      soldAt: new Date(candidate.soldAtMs).toISOString(),
      timestampEvidence: candidate.timestampEvidence,
      priceTon: candidate.priceTon,
      adjustedPriceTon: candidate.adjustedPriceTon,
      robustAdjustedPriceTon: safeExp(candidate.robustAdjustedLogPrice),
      priceAdjustmentFactor: candidate.priceAdjustmentFactor,
      similarity: candidate.similarity,
      ngramSimilarity: candidate.ngramSimilarity,
      editSimilarity: candidate.editSimilarity,
      structuralPenalty: candidate.structuralPenalty,
      segmentPenalty: candidate.segmentPenalty,
      ageDays: candidate.ageDays,
      recencyWeight: candidate.recencyWeight,
      weight: weightSum > 0 ? candidate.finalWeight / weightSum : 0,
    }),
  );

  return {
    username,
    valuationAt: new Date(valuationAtMs).toISOString(),
    p10Ton,
    p50Ton,
    p90Ton,
    confidence,
    outOfDistribution: oodReasons.length > 0,
    oodReasons,
    effectiveSampleSize: effectiveN,
    eligibleRecordCount,
    comparableCount: selected.length,
    exactComparableCount,
    observedComparableCount,
    timestampEvidenceQuality,
    conflictingEventIdCount: conflictingEventIds.size,
    topComparables,
  };
}

/**
 * The sole production retrieval adapter. Training/backtests and live inference
 * must call this function so selection and confidence semantics cannot drift.
 */
export function estimateProductionComparablePrice(
  username: string,
  history: readonly ComparableSaleRecord[],
  valuationAt: ComparableTimestamp,
  exclusions: Pick<
    ComparableEstimatorOptions,
    "excludeEventId" | "excludeEventIds"
  > = {},
): ComparableEstimate {
  return estimateComparablePrice(username, history, valuationAt, {
    ...exclusions,
    recencyHalfLifeDays: DEFAULTS.recencyHalfLifeDays,
    maxComparables: DEFAULTS.maxComparables,
    topComparableCount: DEFAULTS.topComparableCount,
    minimumSimilarity: DEFAULTS.minimumSimilarity,
    similarityPower: DEFAULTS.similarityPower,
    outlierClipZ: DEFAULTS.outlierClipZ,
    minimumLogScale: DEFAULTS.minimumLogScale,
    maxPriceAdjustmentFactor: DEFAULTS.maxPriceAdjustmentFactor,
    minimumEffectiveSampleSize: DEFAULTS.minimumEffectiveSampleSize,
    minimumBestSimilarity: DEFAULTS.minimumBestSimilarity,
    minimumAverageSimilarity: DEFAULTS.minimumAverageSimilarity,
    observedTimestampWeight: DEFAULTS.observedTimestampWeight,
  });
}
