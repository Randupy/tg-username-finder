import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateLiquidity,
  estimateUsernameLiquidity,
  type LiquidityListingObservation,
} from "../src/priceModel/liquidity.js";

const DAY_MS = 86_400_000;
const ORIGIN = Date.UTC(2025, 0, 1);

function atDay(day: number): number {
  return ORIGIN + day * DAY_MS;
}

function observation(
  id: string,
  status: LiquidityListingObservation["status"],
  listedDay: number,
  eventDay: number | null,
  overrides: Partial<LiquidityListingObservation> = {},
): LiquidityListingObservation {
  return {
    id,
    username: "market",
    status,
    askTon: 100,
    listedAt: atDay(listedDay),
    ...(status === "sold" && eventDay !== null
      ? { soldAt: atDay(eventDay) }
      : status !== "active" && eventDay !== null
        ? { endedAt: atDay(eventDay) }
        : {}),
    segment: "dictionary",
    similarity: 1,
    ...overrides,
  };
}

test("active listings are right-censored while expired/cancelled are competing non-sales", () => {
  const valuationAt = atDay(20);
  const sold = observation("sale", "sold", 0, 10);
  // This row has only five days of follow-up and leaves the risk set before
  // the ten-day sale. Right-censoring must not count it as a failed sale.
  const active = observation("other", "active", 15, null);
  const expired = observation("other", "expired", 0, 5);
  const cancelled = observation("other", "cancelled", 0, 5);
  const target = { username: "market", askTon: 100, segment: "dictionary" };

  const withActive = estimateLiquidity(target, [sold, active], valuationAt);
  const withExpired = estimateLiquidity(target, [sold, expired], valuationAt);
  const withCancelled = estimateLiquidity(target, [sold, cancelled], valuationAt);

  assert.equal(withActive.saleProbability30d, 1);
  assert.ok(withExpired.saleProbability30d < withActive.saleProbability30d);
  assert.ok(withCancelled.saleProbability30d < withActive.saleProbability30d);
  assert.equal(withActive.rightCensoredObservationCount, 1);
  assert.equal(withActive.competingObservationCount, 0);
  assert.equal(withExpired.rightCensoredObservationCount, 0);
  assert.equal(withExpired.competingObservationCount, 1);
  assert.equal(
    withActive.topDiagnostics.find((row) => row.id === "other")?.eventType,
    "right-censored",
  );
  assert.equal(
    withExpired.topDiagnostics.find((row) => row.id === "other")?.eventType,
    "competing",
  );
});

test("future outcomes and future listings cannot leak into a historical valuation", () => {
  const valuationAt = atDay(20);
  const history = [
    observation("past-sale-1", "sold", 0, 8, { salePriceTon: 95 }),
    observation("past-sale-2", "sold", 3, 16, { salePriceTon: 105 }),
    observation("future-outcome", "active", 2, null),
  ];
  const target = { username: "market", askTon: 100, segment: "dictionary" };
  const baseline = estimateLiquidity(target, history, valuationAt);
  const withFutureKnowledge = estimateLiquidity(
    target,
    [
      history[0],
      history[1],
      observation("future-outcome", "sold", 2, 40, {
        salePriceTon: 10_000_000,
      }),
      observation("future-listing", "sold", 21, 22, {
        salePriceTon: 90_000_000,
      }),
    ],
    valuationAt,
  );

  assert.deepEqual(withFutureKnowledge, baseline);
  const censored = withFutureKnowledge.topDiagnostics.find(
    (row) => row.id === "future-outcome",
  );
  assert.equal(censored?.status, "active");
  assert.equal(censored?.eventType, "right-censored");
  assert.equal(censored?.realizedSalePriceTon, undefined);
});

test("an explicit last observation prevents stale active-listing follow-up", () => {
  const estimate = estimateLiquidity(
    { username: "market", askTon: 100 },
    [
      observation("stale", "active", 0, null, {
        lastObservedAt: atDay(2),
      }),
    ],
    atDay(400),
    { minimumSimilarity: 0 },
  );

  assert.equal(estimate.rightCensoredObservationCount, 1);
  assert.equal(estimate.topDiagnostics[0]?.durationDays, 2);
  assert.equal(estimate.topDiagnostics[0]?.observedThrough, new Date(atDay(2)).toISOString());
});

test("probabilities are monotonic, estimates are deterministic and prices remain finite", () => {
  const history: LiquidityListingObservation[] = [
    observation("sold-10", "sold", 0, 10, { salePriceTon: 90 }),
    observation("sold-45", "sold", 20, 65, { salePriceTon: 90 }),
    observation("sold-180", "sold", 80, 260, { salePriceTon: 90 }),
    observation("expired-70", "expired", 100, 170),
    observation("cancelled-120", "cancelled", 120, 240),
    observation("active-long", "active", 0, null),
  ];
  const valuationAt = atDay(400);
  const options = {
    topDiagnosticCount: 20,
    minimumEffectiveSampleSize: 0,
    minimumBestSimilarity: 0,
    minimumAverageSimilarity: 0,
  };
  const target = { username: "market", askTon: 100, segment: "dictionary" };

  const estimate = estimateLiquidity(target, history, valuationAt, options);
  const reversed = estimateUsernameLiquidity(
    target,
    [...history].reverse(),
    valuationAt,
    options,
  );

  assert.deepEqual(estimate, reversed);
  assert.ok(estimate.saleProbability30d >= 0);
  assert.ok(estimate.saleProbability30d <= estimate.saleProbability90d);
  assert.ok(estimate.saleProbability90d <= estimate.saleProbability365d);
  assert.ok(estimate.saleProbability365d <= 1);
  assert.ok(estimate.medianDaysToSale === null || estimate.medianDaysToSale >= 0);
  assert.ok(estimate.expectedSalePriceTon !== null);
  assert.ok(Math.abs(estimate.expectedSalePriceTon - 90) < 1e-10);
  assert.ok(Number.isFinite(estimate.effectiveSampleSize));
  assert.ok(Number.isFinite(estimate.confidence));
  assert.ok(estimate.confidence >= 0 && estimate.confidence <= 1);
  assert.ok(
    estimate.topDiagnostics.every((row) =>
      [
        row.durationDays,
        row.similarity,
        row.segmentWeight,
        row.askWeight,
        row.recencyWeight,
        row.weight,
      ].every(Number.isFinite),
    ),
  );
  const diagnosticWeight = estimate.topDiagnostics.reduce(
    (sum, row) => sum + row.weight,
    0,
  );
  assert.ok(Math.abs(diagnosticWeight - 1) < 1e-12);
});

test("empty and all-censored cohorts return explicit low-confidence/OOD output", () => {
  const valuationAt = atDay(20);
  const empty = estimateLiquidity("market", [], valuationAt);
  assert.deepEqual(
    [
      empty.saleProbability30d,
      empty.saleProbability90d,
      empty.saleProbability365d,
      empty.effectiveSampleSize,
      empty.confidence,
    ],
    [0, 0, 0, 0, 0],
  );
  assert.equal(empty.medianDaysToSale, null);
  assert.equal(empty.expectedSalePriceTon, null);
  assert.equal(empty.outOfDistribution, true);

  const censored = estimateLiquidity(
    { username: "market", askTon: 100 },
    [
      observation("active-1", "active", 0, null),
      observation("active-2", "active", 5, null),
      observation("active-3", "active", 10, null),
    ],
    valuationAt,
  );
  assert.equal(censored.saleProbability365d, 0);
  assert.equal(censored.expectedSalePriceTon, null);
  assert.equal(censored.soldObservationCount, 0);
  assert.equal(censored.rightCensoredObservationCount, 3);
  assert.ok(censored.oodReasons.includes("no-observed-sales"));
});
