import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMarketEventId,
  hashCounterparty,
  loadMarketEvents,
  MarketEventWarehouseError,
  mergeMarketEvents,
  migrateSoldRecords,
  normalizeMarketEvent,
  saveMarketEvents,
  soldRecordToMarketEvent,
  validateMarketEvent,
  type MarketEvent,
} from "../src/priceData/marketEvents.js";

const OBSERVED_AT = "2026-07-31T12:00:00.000Z";
const NFT_ITEM = "EQBJUoXYcrC0qSy6oGcueWsx-zDjo7t6zXOE1_nsWWVnSadw";

function sale(
  username: string,
  priceTon: number,
  eventAt: string,
  observedAt = OBSERVED_AT,
): MarketEvent {
  const event = normalizeMarketEvent({
    eventType: "sale",
    username,
    eventAt,
    observedAt,
    priceTon,
    saleFormat: "auction",
    marketPhase: "secondary",
    nftItemAddress: NFT_ITEM,
    counterparties: {
      seller: hashCounterparty(`seller:${username}`),
      buyer: hashCounterparty(`buyer:${username}:${eventAt}`),
    },
    provenance: {
      source: "fragment",
      parser: "fragment-sold-table",
      sourceEventId: `fixture-sale:${username}:${eventAt}`,
    },
    confidence: "high",
  });
  assert.ok(event);
  return event;
}

test("strict normalization canonicalizes and deeply freezes a complete sale", () => {
  const event = normalizeMarketEvent({
    eventType: "sale",
    username: "@Alpha",
    eventAt: "2025-01-02T03:04:05+00:00",
    observedAt: "2026-07-31T17:00:00+05:00",
    priceTon: 123.5,
    feesTon: 6.25,
    saleFormat: "auction",
    marketPhase: "secondary",
    txHash: "a".repeat(64),
    nftItemAddress: NFT_ITEM,
    counterparties: {
      seller: hashCounterparty("seller-wallet", "test"),
      buyer: hashCounterparty("buyer-wallet", "test"),
    },
    provenance: {
      source: "Fragment",
      parser: "Fragment-Sold-Table",
      sourceUrl: "https://fragment.com/?filter=sold",
      assetUrl: "https://fragment.com/username/alpha",
      page: 1,
      rowIndex: 0,
    },
    confidence: "high",
  });

  assert.ok(event);
  assert.equal(event.username, "alpha");
  assert.equal(event.eventAt, "2025-01-02T03:04:05.000Z");
  assert.equal(event.observedAt, OBSERVED_AT);
  assert.equal(event.provenance.assetUrl, "https://fragment.com/username/alpha");
  assert.match(event.eventId, /^market:v1:[a-f0-9]{40}$/);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.provenance), true);
  assert.equal(Object.isFrozen(event.counterparties), true);
});

test("validation rejects ambiguous prices, raw counterparties and impossible times", () => {
  const invalidSale = validateMarketEvent({
    eventType: "sale",
    username: "alpha",
    eventAt: "2026-08-01T00:00:00Z",
    observedAt: OBSERVED_AT,
    seller: "raw-wallet-address",
    saleFormat: "auction",
    marketPhase: "secondary",
    provenance: { source: "fragment" },
    confidence: "high",
  });
  assert.equal(invalidSale.ok, false);
  if (!invalidSale.ok) {
    assert.ok(invalidSale.errors.some((error) => /priceTon/.test(error)));
    assert.ok(invalidSale.errors.some((error) => /seller is forbidden/.test(error)));
    assert.ok(invalidSale.errors.some((error) => /later than observedAt/.test(error)));
  }

  const invalidListing = validateMarketEvent({
    eventType: "listed",
    username: "alpha",
    observedAt: OBSERVED_AT,
    saleFormat: "fixed-price",
    marketPhase: "secondary",
    provenance: { source: "fragment" },
    confidence: "medium",
  });
  assert.equal(invalidListing.ok, false);
  if (!invalidListing.ok) {
    assert.ok(invalidListing.errors.some((error) => /askTon or reserveTon/.test(error)));
  }
});

test("stable ids ignore re-observation time but distinguish repeated sales", () => {
  const base = {
    eventType: "sale" as const,
    username: "alpha",
    eventAt: "2025-01-02T03:04:05Z",
    observedAt: "2025-01-03T00:00:00Z",
    priceTon: 100,
    saleFormat: "auction" as const,
    marketPhase: "secondary" as const,
    provenance: { source: "fragment" },
  };
  const first = buildMarketEventId(base);
  const reObserved = buildMarketEventId({
    ...base,
    observedAt: "2026-07-31T00:00:00Z",
  });
  const resale = buildMarketEventId({
    ...base,
    eventAt: "2025-02-02T03:04:05Z",
  });

  assert.equal(first, reObserved);
  assert.notEqual(first, resale);
});

test("uncertain observations use one explicit cluster identity across scrapes", () => {
  const first = normalizeMarketEvent({
    eventType: "sale",
    username: "legacy_name",
    observedAt: "2026-07-30T00:00:00Z",
    priceTon: 10,
    provenance: { source: "fragment" },
    confidence: "low",
  });
  const refreshed = normalizeMarketEvent({
    eventType: "sale",
    username: "legacy_name",
    observedAt: "2026-07-31T00:00:00Z",
    priceTon: 12,
    provenance: { source: "fragment" },
    confidence: "low",
  });
  assert.ok(first);
  assert.ok(refreshed);
  assert.equal(first.identityKind, "observation-cluster");
  assert.equal(first.eventId, refreshed.eventId);

  const merged = mergeMarketEvents([first], [refreshed]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].identityKind, "observation-cluster");
  assert.equal(merged[0].eventAt, undefined);
  assert.equal(merged[0].priceTon, 12);
  assert.equal(merged[0].observedAt, "2026-07-31T00:00:00.000Z");
});

test("fallback exact-event ids ignore enrichment and supplied ids must be canonical", () => {
  const base = {
    eventType: "sale" as const,
    username: "alpha",
    eventAt: "2025-01-02T03:04:05Z",
    observedAt: OBSERVED_AT,
    priceTon: 100,
    provenance: { source: "fragment" },
  };
  const initialId = buildMarketEventId(base);
  const enrichedId = buildMarketEventId({
    ...base,
    feesTon: 8,
    saleFormat: "auction",
    marketPhase: "secondary",
    nftItemAddress: NFT_ITEM,
    counterparties: { buyer: hashCounterparty("enriched-buyer") },
  });
  assert.equal(initialId, enrichedId);

  const invalid = validateMarketEvent({
    ...base,
    eventId: "fragment:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    confidence: "medium",
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.ok(invalid.errors.some((error) => /canonical identity/.test(error)));
  }

  const canonical = normalizeMarketEvent({
    ...base,
    eventId: initialId,
    confidence: "medium",
  });
  assert.ok(canonical);
  assert.equal(canonical.eventId, initialId);
});

test("high-confidence sales require exact time and a stable upstream identity", () => {
  const withoutExactTime = validateMarketEvent({
    eventType: "sale",
    username: "alpha",
    observedAt: OBSERVED_AT,
    priceTon: 100,
    provenance: { source: "fragment", sourceEventId: "sale-alpha" },
    confidence: "high",
  });
  assert.equal(withoutExactTime.ok, false);
  if (!withoutExactTime.ok) {
    assert.ok(withoutExactTime.errors.some((error) => /exact eventAt/.test(error)));
  }

  const withoutStableIdentity = validateMarketEvent({
    eventType: "sale",
    username: "alpha",
    eventAt: "2025-01-02T03:04:05Z",
    observedAt: OBSERVED_AT,
    priceTon: 100,
    provenance: { source: "fragment" },
    confidence: "high",
  });
  assert.equal(withoutStableIdentity.ok, false);
  if (!withoutStableIdentity.ok) {
    assert.ok(
      withoutStableIdentity.errors.some((error) => /txHash or provenance\.sourceEventId/.test(error)),
    );
  }
});

test("source and transaction identities survive enrichment and merge into one event", () => {
  const sourceEventId = "toncenter-action-alpha-sale-1";
  const txHash = "b".repeat(64);
  const minimal = normalizeMarketEvent({
    eventType: "sale",
    username: "alpha",
    observedAt: OBSERVED_AT,
    priceTon: 100,
    saleFormat: "unknown",
    marketPhase: "unknown",
    provenance: { source: "toncenter", sourceEventId },
    confidence: "low",
  });
  const enriched = normalizeMarketEvent({
    eventType: "sale",
    username: "alpha",
    eventAt: "2025-01-02T03:04:05Z",
    observedAt: OBSERVED_AT,
    priceTon: 100,
    feesTon: 5,
    saleFormat: "auction",
    marketPhase: "secondary",
    txHash,
    nftItemAddress: NFT_ITEM,
    counterparties: {
      seller: hashCounterparty("stable-id-seller"),
      buyer: hashCounterparty("stable-id-buyer"),
    },
    provenance: {
      source: "toncenter",
      sourceEventId,
      parser: "toncenter-reconciliation-v1",
    },
    confidence: "high",
  });
  assert.ok(minimal);
  assert.ok(enriched);
  assert.equal(minimal.eventId, enriched.eventId);

  const txOnlyBase = {
    eventType: "sale" as const,
    username: "bravo",
    observedAt: OBSERVED_AT,
    priceTon: 250,
    txHash,
    provenance: { source: "toncenter" },
  };
  assert.equal(
    buildMarketEventId(txOnlyBase),
    buildMarketEventId({
      ...txOnlyBase,
      eventAt: "2025-02-03T04:05:06Z",
      feesTon: 7.5,
      saleFormat: "auction",
      marketPhase: "secondary",
      nftItemAddress: NFT_ITEM,
      counterparties: { buyer: hashCounterparty("tx-only-buyer") },
    }),
  );

  const merged = mergeMarketEvents([minimal], [enriched]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].eventId, minimal.eventId);
  assert.equal(merged[0].eventAt, "2025-01-02T03:04:05.000Z");
  assert.equal(merged[0].feesTon, 5);
  assert.equal(merged[0].saleFormat, "auction");
  assert.equal(merged[0].marketPhase, "secondary");
  assert.equal(merged[0].txHash, txHash);
  assert.equal(merged[0].nftItemAddress, NFT_ITEM);
  assert.equal(merged[0].confidence, "high");
  assert.deepEqual(merged[0].counterparties, enriched.counterparties);

  const conflictingPrice = normalizeMarketEvent({
    ...enriched,
    eventId: undefined,
    priceTon: 999,
  });
  assert.ok(conflictingPrice);
  assert.equal(conflictingPrice.eventId, minimal.eventId);
  assert.throws(
    () => mergeMarketEvents(merged, [conflictingPrice]),
    /Conflicting priceTon/,
  );
});

test("immutable merge preserves resales, enriches duplicates and rejects collisions", () => {
  const firstSale = sale("alpha", 100, "2024-01-01T00:00:00Z");
  const secondSale = sale("alpha", 250, "2025-01-01T00:00:00Z");
  const lessCertainCopy = normalizeMarketEvent({
    ...firstSale,
    observedAt: "2026-07-30T00:00:00Z",
    confidence: "low",
    provenance: firstSale.provenance,
  });
  assert.ok(lessCertainCopy);

  const existing = Object.freeze([firstSale]);
  const merged = mergeMarketEvents(existing, [lessCertainCopy, secondSale]);

  assert.equal(existing.length, 1);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((event) => event.priceTon),
    [100, 250],
  );
  assert.equal(merged[0].confidence, "high");
  assert.equal(merged[0].observedAt, "2026-07-30T00:00:00.000Z");
  assert.equal(Object.isFrozen(merged), true);

  const collision = normalizeMarketEvent({
    ...firstSale,
    priceTon: 999,
    eventId: firstSale.eventId,
  });
  assert.ok(collision);
  assert.throws(
    () => mergeMarketEvents([firstSale], [collision]),
    /Conflicting priceTon/,
  );
});

test("SoldRecord migration keeps exact eventAt separate from observedAt and preserves resales", () => {
  const records = [
    {
      username: "Alpha",
      priceTon: 100,
      saleAt: "2024-01-01T00:00:00Z",
      scrapedAt: "2026-07-30T00:00:00Z",
      eventId: "fragment:11111111111111111111111111111111",
      source: "fragment",
      confidence: "high",
      provenance: {
        parser: "fragment-sold-table",
        assetUrl: "https://fragment.com/username/alpha",
      },
    },
    {
      username: "alpha",
      priceTon: 250,
      saleAt: "2025-01-01T00:00:00Z",
      scrapedAt: "2026-07-31T00:00:00Z",
      eventId: "fragment:22222222222222222222222222222222",
      source: "fragment",
      confidence: "high",
      provenance: { parser: "fragment-sold-table" },
    },
  ];
  const migrated = migrateSoldRecords(records);

  assert.equal(migrated.length, 2);
  assert.deepEqual(
    migrated.map((event) => event.eventAt),
    ["2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
  );
  assert.notEqual(migrated[0].observedAt, migrated[0].eventAt);
  assert.deepEqual(
    migrated.map((event) => event.eventId),
    migrated.map((event) => buildMarketEventId(event)),
  );
  assert.deepEqual(
    migrated.map((event) => event.provenance.sourceEventId),
    records.map((record) => record.eventId),
  );
  assert.equal(
    migrated[0].provenance.assetUrl,
    "https://fragment.com/username/alpha",
  );
  assert.ok(
    migrated.every((event, index) => event.eventId !== records[index].eventId),
  );

  const legacy = soldRecordToMarketEvent({
    username: "legacy_name",
    priceTon: 10,
    scrapedAt: OBSERVED_AT,
  });
  assert.ok(legacy);
  assert.equal(legacy.eventAt, undefined);
  assert.equal(legacy.observedAt, OBSERVED_AT);
  assert.equal(legacy.confidence, "low");
  assert.equal(legacy.identityKind, "observation-cluster");

  const repeatedUncertain = migrateSoldRecords([
    {
      username: "legacy_name",
      priceTon: 10,
      scrapedAt: "2026-07-30T00:00:00Z",
    },
    {
      username: "legacy_name",
      priceTon: 12,
      scrapedAt: "2026-07-31T00:00:00Z",
    },
  ]);
  assert.equal(repeatedUncertain.length, 1);
  assert.equal(repeatedUncertain[0].identityKind, "observation-cluster");
  assert.equal(repeatedUncertain[0].priceTon, 12);
  assert.equal(repeatedUncertain[0].eventAt, undefined);
});

test("a conflicting warehouse fails closed without erasing valid evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-market-collision-"));
  const path = join(directory, "market-events.json");
  try {
    const original = sale("alpha", 100, "2025-01-01T00:00:00Z");
    const conflicting = normalizeMarketEvent({
      ...original,
      eventId: undefined,
      priceTon: 999,
    });
    const unrelated = sale("bravo", 250, "2025-02-01T00:00:00Z");
    assert.ok(conflicting);
    assert.equal(conflicting.eventId, original.eventId);
    const originalBytes = JSON.stringify([original, conflicting, unrelated]);
    writeFileSync(path, originalBytes, "utf8");

    assert.throws(
      () => loadMarketEvents(path),
      (error: unknown) => {
        assert.ok(error instanceof MarketEventWarehouseError);
        assert.match(error.message, /refusing partial load/);
        assert.match(error.message, /Conflicting priceTon/);
        return true;
      },
    );
    assert.throws(
      () => saveMarketEvents([unrelated], path),
      MarketEventWarehouseError,
    );
    assert.equal(readFileSync(path, "utf8"), originalBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed JSON cannot be mistaken for an empty writable warehouse", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-market-malformed-"));
  const path = join(directory, "market-events.json");
  const malformed = '{"events":[';
  try {
    writeFileSync(path, malformed, "utf8");
    assert.throws(
      () => loadMarketEvents(path),
      (error: unknown) => {
        assert.ok(error instanceof MarketEventWarehouseError);
        assert.match(error.message, /cannot read valid JSON/);
        return true;
      },
    );
    assert.throws(
      () => saveMarketEvents([sale("alpha", 100, "2025-01-01T00:00:00Z")], path),
      MarketEventWarehouseError,
    );
    assert.equal(readFileSync(path, "utf8"), malformed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("save/load round-trip is immutable and load migrates a legacy array", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-market-events-"));
  const marketPath = join(directory, "market-events.json");
  const legacyPath = join(directory, "sold-history.json");
  try {
    const event = sale("alpha", 100, "2025-01-01T00:00:00Z");
    saveMarketEvents([event], marketPath);
    const loaded = loadMarketEvents(marketPath);
    assert.deepEqual(loaded, [event]);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded[0]), true);

    writeFileSync(
      legacyPath,
      JSON.stringify([
        {
          username: "legacy_name",
          priceTon: 42,
          scrapedAt: OBSERVED_AT,
        },
      ]),
      "utf8",
    );
    const migrated = loadMarketEvents(legacyPath);
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].eventType, "sale");
    assert.equal(migrated[0].eventAt, undefined);
    assert.equal(migrated[0].observedAt, OBSERVED_AT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
