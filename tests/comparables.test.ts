import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPARABLE_PIPELINE_SIGNATURE,
  COMPARABLE_PIPELINE_VERSION,
  estimateComparablePrice,
  estimateProductionComparablePrice,
  usernameSimilarity,
  type ComparableSaleRecord,
} from "../src/priceModel/comparables.js";

const DAY_MS = 86_400_000;

function sale(
  username: string,
  priceTon: number,
  day: number,
  eventId?: string,
): ComparableSaleRecord {
  return {
    username,
    priceTon,
    soldAt: new Date(Date.UTC(2025, 0, day)).toISOString(),
    ...(eventId === undefined ? {} : { eventId }),
  };
}

test("similarity ranks close lexical and structural matches above unrelated names", () => {
  const exact = usernameSimilarity("@Market", "market");
  const close = usernameSimilarity("market", "markets");
  const digitVariant = usernameSimilarity("market", "market99");
  const unrelated = usernameSimilarity("market", "qxzvbn");

  assert.equal(exact, 1);
  assert.ok(close > digitVariant, `${close} should exceed ${digitVariant}`);
  assert.ok(digitVariant > unrelated, `${digitVariant} should exceed ${unrelated}`);
  assert.ok(unrelated >= 0 && unrelated <= 1);
});

test("future records and the target event cannot leak into a historical valuation", () => {
  const valuationAt = new Date(Date.UTC(2025, 0, 20));
  const past = [
    sale("marketplace", 96, 2, "past-1"),
    sale("marketings", 103, 5, "past-2"),
    sale("marketplace1", 108, 8, "past-3"),
    sale("marketer", 101, 12, "past-4"),
    sale("markets", 99, 16, "past-5"),
  ];
  const options = { excludeEventId: "target-event", minimumSimilarity: 0 };

  const baseline = estimateComparablePrice("market", past, valuationAt, options);
  const withLeaks = estimateComparablePrice(
    "market",
    [
      ...past,
      sale("market", 50_000_000, 20, "target-event"),
      sale("market", 90_000_000, 21, "future-event"),
    ],
    valuationAt,
    options,
  );

  assert.deepEqual(withLeaks, baseline);
});

test("the pinned production adapter is shared, deterministic and strictly pre-event", () => {
  const valuationAt = new Date(Date.UTC(2025, 0, 20));
  const history = [
    sale("markets", 100, 10, "past"),
    sale("market", 1_000_000, 20, "same-time"),
  ];
  const estimate = estimateProductionComparablePrice("market", history, valuationAt);

  assert.equal(COMPARABLE_PIPELINE_VERSION, 1);
  assert.match(COMPARABLE_PIPELINE_SIGNATURE, /strictly-before/);
  assert.equal(estimate.eligibleRecordCount, 1);
  assert.equal(estimate.topComparables[0]?.eventId, "past");
});

test("exact saleAt takes precedence over later observation-time fallbacks", () => {
  const valuationAt = "2025-01-20T00:00:00.000Z";
  const exactPastObservedLater: ComparableSaleRecord = {
    username: "markets",
    priceTon: 100,
    saleAt: "2025-01-10T00:00:00.000Z",
    soldAt: "2025-02-10T00:00:00.000Z",
    eventAt: "2025-02-11T00:00:00.000Z",
    scrapedAt: "2025-02-12T00:00:00.000Z",
    eventId: "exact-past",
  };
  const exactFutureObservedEarlier: ComparableSaleRecord = {
    username: "marketa",
    priceTon: 1_000_000,
    saleAt: "2025-01-21T00:00:00.000Z",
    scrapedAt: "2025-01-01T00:00:00.000Z",
    eventId: "exact-future",
  };

  const estimate = estimateComparablePrice(
    "market",
    [exactPastObservedLater, exactFutureObservedEarlier],
    valuationAt,
    { minimumSimilarity: 0 },
  );

  assert.equal(estimate.eligibleRecordCount, 1);
  assert.equal(estimate.comparableCount, 1);
  assert.equal(estimate.topComparables[0]?.eventId, "exact-past");
  assert.equal(estimate.topComparables[0]?.soldAt, "2025-01-10T00:00:00.000Z");
});

test("robust weighted quantiles resist a single extreme comparable", () => {
  const names = [
    "marketa",
    "marketb",
    "marketc",
    "marketd",
    "markete",
    "marketf",
    "marketg",
    "marketh",
    "marketi",
  ];
  const normalSales = names.map((username, index) =>
    sale(username, 92 + index * 2, index + 1, `normal-${index}`),
  );
  const history = [...normalSales, sale("marketz", 1_000_000_000_000, 10, "outlier")];

  const estimate = estimateComparablePrice(
    "market",
    history,
    new Date(Date.UTC(2025, 0, 30)),
    { topComparableCount: 20 },
  );

  assert.ok(Number.isFinite(estimate.p10Ton));
  assert.ok(Number.isFinite(estimate.p50Ton));
  assert.ok(Number.isFinite(estimate.p90Ton));
  assert.ok(estimate.p10Ton <= estimate.p50Ton);
  assert.ok(estimate.p50Ton <= estimate.p90Ton);
  assert.ok(estimate.p50Ton < 150, `unexpected median: ${estimate.p50Ton}`);
  assert.ok(estimate.p90Ton < 500, `outlier leaked into P90: ${estimate.p90Ton}`);
  assert.ok(estimate.effectiveSampleSize > 5);
  assert.equal(estimate.comparableCount, 10);

  const outlier = estimate.topComparables.find((row) => row.eventId === "outlier");
  assert.ok(outlier);
  assert.ok(outlier.adjustedPriceTon > 1_000_000_000);
  assert.ok(outlier.robustAdjustedPriceTon < 500);
});

test("recency, diagnostic rows and empty/OOD output remain deterministic and finite", () => {
  const valuationAt = Date.UTC(2025, 5, 1);
  const history = [
    sale("signalx", 120, 1, "old"),
    {
      username: "signaly",
      priceTon: 130,
      soldAt: valuationAt - 2 * DAY_MS,
      eventId: "recent",
    },
  ];

  const first = estimateComparablePrice("signal", history, valuationAt);
  const second = estimateComparablePrice("signal", [...history].reverse(), valuationAt);
  assert.deepEqual(first, second);
  assert.equal(first.topComparables[0].eventId, "recent");
  assert.ok(first.topComparables.every((row) => Number.isFinite(row.adjustedPriceTon)));
  assert.ok(first.confidence >= 0 && first.confidence <= 1);

  const empty = estimateComparablePrice("signal", [], valuationAt);
  assert.deepEqual(
    [empty.p10Ton, empty.p50Ton, empty.p90Ton, empty.effectiveSampleSize, empty.confidence],
    [0, 0, 0, 0, 0],
  );
  assert.equal(empty.outOfDistribution, true);
});
