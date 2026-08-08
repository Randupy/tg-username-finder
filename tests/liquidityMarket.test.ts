import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMarketEvent,
  type MarketEvent,
  type MarketEventType,
} from "../src/priceData/marketEvents.js";
import {
  estimateLiquidityFromMarketEvents,
  marketEventsToLiquidityListings,
} from "../src/priceModel/liquidityMarket.js";

function event(
  eventType: MarketEventType,
  eventAt: string,
  values: Partial<MarketEvent> = {},
): MarketEvent {
  const normalized = normalizeMarketEvent({
    schemaVersion: 1,
    eventType,
    username: "alpha",
    eventAt,
    observedAt: "2025-06-01T00:00:00.000Z",
    ...(eventType === "listed" ? { askTon: 100 } : {}),
    ...(eventType === "sale" ? { priceTon: 90 } : {}),
    saleFormat: "fixed-price",
    marketPhase: "secondary",
    provenance: {
      source: "fixture",
      ...(eventType === "sale"
        ? { sourceEventId: `sale:${eventAt}` }
        : {}),
    },
    confidence: "high",
    ...values,
  });
  assert.ok(normalized);
  return normalized;
}

test("market event adapter reconstructs an unambiguous listing lifecycle", () => {
  const listed = event("listed", "2025-01-01T00:00:00.000Z");
  const sold = event("sale", "2025-01-21T00:00:00.000Z");
  const built = marketEventsToLiquidityListings([sold, listed]);

  assert.equal(built.observations.length, 1);
  assert.equal(built.observations[0].status, "sold");
  assert.equal(built.observations[0].salePriceTon, 90);
  assert.equal(built.diagnostics.matchedTerminalCount, 1);
});

test("same-market price updates close the old exposure instead of staying ambiguous", () => {
  const events = [
    event("listed", "2025-01-01T00:00:00.000Z", { askTon: 100 }),
    event("listed", "2025-01-02T00:00:00.000Z", { askTon: 120 }),
    event("sale", "2025-01-21T00:00:00.000Z"),
  ];
  const built = marketEventsToLiquidityListings(events);

  assert.equal(built.diagnostics.ambiguousTerminalCount, 0);
  assert.equal(built.diagnostics.repricedListingCount, 1);
  assert.deepEqual(
    built.observations.map((observation) => observation.status),
    ["cancelled", "sold"],
  );
  assert.deepEqual(
    built.observations.map((observation) => observation.askTon),
    [100, 120],
  );
});

test("overlapping listings from different markets remain ambiguous", () => {
  const events = [
    event("listed", "2025-01-01T00:00:00.000Z", {
      askTon: 100,
      provenance: { source: "market-a" },
    }),
    event("listed", "2025-01-02T00:00:00.000Z", {
      askTon: 120,
      provenance: { source: "market-b" },
    }),
    event("sale", "2025-01-21T00:00:00.000Z", {
      provenance: { source: "market-c", sourceEventId: "sale-alpha" },
    }),
  ];
  const built = marketEventsToLiquidityListings(events);

  assert.equal(built.diagnostics.ambiguousTerminalCount, 1);
  assert.deepEqual(
    built.observations.map((observation) => observation.status),
    ["active", "active"],
  );
});

test("a lone listing event does not fabricate follow-up through valuation time", () => {
  const listed = event("listed", "2025-01-01T00:00:00.000Z");
  const built = marketEventsToLiquidityListings([listed]);
  assert.equal(built.observations[0]?.lastObservedAt, listed.eventAt);

  const current = estimateLiquidityFromMarketEvents(
    { username: "alpha", askTon: 100 },
    [listed],
    "2025-12-31T00:00:00.000Z",
    { minimumSimilarity: 0 },
  );

  assert.equal(current.estimate.rightCensoredObservationCount, 1);
  assert.equal(current.estimate.topDiagnostics[0]?.durationDays, 0);
  assert.equal(current.estimate.topDiagnostics[0]?.observedThrough, listed.eventAt);
});

test("historical market estimate hides a future sale through censoring", () => {
  const events = [
    event("listed", "2025-01-01T00:00:00.000Z"),
    event("sale", "2025-01-21T00:00:00.000Z"),
  ];
  const historical = estimateLiquidityFromMarketEvents(
    { username: "alpha", askTon: 100 },
    events,
    "2025-01-10T00:00:00.000Z",
    { minimumSimilarity: 0 },
  );

  assert.equal(historical.estimate.soldObservationCount, 0);
  assert.equal(historical.estimate.rightCensoredObservationCount, 1);
  assert.equal(historical.estimate.expectedSalePriceTon, null);
});

test("observation-only timestamps never create liquidity durations", () => {
  const observedOnly = normalizeMarketEvent({
    eventType: "listed",
    username: "alpha",
    observedAt: "2025-06-01T00:00:00.000Z",
    askTon: 100,
    saleFormat: "fixed-price",
    marketPhase: "secondary",
    provenance: { source: "fixture" },
    confidence: "medium",
  });
  assert.ok(observedOnly);

  const built = marketEventsToLiquidityListings([observedOnly]);
  assert.equal(built.diagnostics.inputEventCount, 1);
  assert.equal(built.diagnostics.exactDatedEventCount, 0);
  assert.equal(built.observations.length, 0);
});

test("unique username/NFT reconciliation and transfers close a listing", () => {
  const nftAddress = `0:${"d".repeat(64)}`;
  const listed = event("listed", "2025-01-01T00:00:00.000Z");
  const transferred = event("transfer", "2025-01-10T00:00:00.000Z", {
    nftItemAddress: nftAddress,
    provenance: { source: "fixture", sourceEventId: "transfer-alpha" },
  });

  const built = marketEventsToLiquidityListings([listed, transferred]);
  assert.equal(built.diagnostics.matchedTerminalCount, 1);
  assert.equal(built.diagnostics.unmatchedTerminalCount, 0);
  assert.equal(built.observations.length, 1);
  assert.equal(built.observations[0].status, "cancelled");
  assert.equal(built.observations[0].endedAt, transferred.eventAt);
});

test("a repeated stable listing identity reopens on a changed ask", () => {
  const identity = { source: "fixture", sourceEventId: "listing-alpha" };
  const events = [
    event("listed", "2025-01-01T00:00:00.000Z", {
      askTon: 100,
      provenance: identity,
    }),
    event("listed", "2025-01-05T00:00:00.000Z", {
      askTon: 80,
      provenance: identity,
    }),
    event("sale", "2025-01-10T00:00:00.000Z"),
  ];

  const built = marketEventsToLiquidityListings(events);
  assert.equal(built.diagnostics.repricedListingCount, 1);
  assert.deepEqual(
    built.observations.map((observation) => [
      observation.askTon,
      observation.status,
      observation.listedAt,
      observation.endedAt,
    ]),
    [
      [
        100,
        "cancelled",
        "2025-01-01T00:00:00.000Z",
        "2025-01-05T00:00:00.000Z",
      ],
      [
        80,
        "sold",
        "2025-01-05T00:00:00.000Z",
        "2025-01-10T00:00:00.000Z",
      ],
    ],
  );
});
