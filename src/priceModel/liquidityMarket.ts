import type { MarketEvent } from "../priceData/marketEvents.js";
import {
  estimateLiquidity,
  type LiquidityEstimate,
  type LiquidityEstimatorOptions,
  type LiquidityListingObservation,
  type LiquidityTarget,
  type LiquidityTimestamp,
} from "./liquidity.js";

export interface LiquidityMarketBuildDiagnostics {
  inputEventCount: number;
  exactDatedEventCount: number;
  listingEventCount: number;
  observationCount: number;
  matchedTerminalCount: number;
  unmatchedTerminalCount: number;
  ambiguousTerminalCount: number;
  invalidListingCount: number;
  repricedListingCount: number;
}

export interface LiquidityMarketBuildResult {
  observations: LiquidityListingObservation[];
  diagnostics: LiquidityMarketBuildDiagnostics;
}

export interface MarketLiquidityEstimate {
  estimate: LiquidityEstimate;
  buildDiagnostics: LiquidityMarketBuildDiagnostics;
}

interface MutableListing extends LiquidityListingObservation {
  id: string;
  status: "sold" | "active" | "expired" | "cancelled";
  assetKey: string;
  openedAtMs: number;
  marketSource: string;
  listingIdentity?: string;
}

function exactEventTime(event: MarketEvent): number | null {
  if (!event.eventAt) return null;
  const timestamp = Date.parse(event.eventAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function usernameKey(event: MarketEvent): string {
  return event.username.toLowerCase();
}

function buildUsernameNftAliases(
  events: readonly MarketEvent[],
): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.nftItemAddress) continue;
    const username = usernameKey(event);
    const values = candidates.get(username) ?? new Set<string>();
    values.add(event.nftItemAddress);
    candidates.set(username, values);
  }
  const aliases = new Map<string, string>();
  for (const [username, nftItems] of candidates) {
    if (nftItems.size === 1) aliases.set(username, [...nftItems][0]);
  }
  return aliases;
}

function assetKey(event: MarketEvent, aliases: ReadonlyMap<string, string>): string {
  const nftItemAddress = event.nftItemAddress ?? aliases.get(usernameKey(event));
  return nftItemAddress
    ? `nft:${nftItemAddress}`
    : `username:${usernameKey(event)}`;
}

function stableListingIdentity(event: MarketEvent): string | undefined {
  if (event.provenance.sourceEventId) {
    return `${event.provenance.source}:source-event:${event.provenance.sourceEventId}`;
  }
  if (event.txHash) return `${event.provenance.source}:tx:${event.txHash}`;
  return undefined;
}

function eventTypeOrder(event: MarketEvent): number {
  // Aggregated sale evidence wins over its transfer leg at the same block
  // timestamp; otherwise the transfer would censor a listing just before the
  // confirmed sale closes it.
  switch (event.eventType) {
    case "listed":
      return 0;
    case "bid":
      return 1;
    case "sale":
      return 2;
    case "transfer":
      return 3;
    case "cancelled":
      return 4;
    case "expired":
      return 5;
    default:
      return 6;
  }
}

function eventOrder(left: MarketEvent, right: MarketEvent): number {
  return (
    (exactEventTime(left) ?? Number.POSITIVE_INFINITY) -
      (exactEventTime(right) ?? Number.POSITIVE_INFINITY) ||
    eventTypeOrder(left) - eventTypeOrder(right) ||
    left.observedAt.localeCompare(right.observedAt) ||
    left.eventId.localeCompare(right.eventId)
  );
}

/**
 * Reconstructs listing lifecycles conservatively from immutable market events.
 * A terminal event is linked only when exactly one compatible listing is open;
 * ambiguous histories remain censored instead of inventing a sale duration.
 */
export function marketEventsToLiquidityListings(
  events: readonly MarketEvent[],
): LiquidityMarketBuildResult {
  const aliases = buildUsernameNftAliases(events);
  const ordered = [...events].sort(eventOrder);
  const listings: MutableListing[] = [];
  const openByAsset = new Map<string, MutableListing[]>();
  let exactDatedEventCount = 0;
  let listingEventCount = 0;
  let matchedTerminalCount = 0;
  let unmatchedTerminalCount = 0;
  let ambiguousTerminalCount = 0;
  let invalidListingCount = 0;
  let repricedListingCount = 0;

  for (const event of ordered) {
    const timestamp = exactEventTime(event);
    if (timestamp === null) continue;
    exactDatedEventCount++;
    const key = assetKey(event, aliases);

    if (event.eventType === "listed") {
      listingEventCount++;
      const askTon = event.askTon ?? event.reserveTon;
      if (askTon === undefined || !Number.isFinite(askTon) || askTon <= 0) {
        invalidListingCount++;
        continue;
      }
      const identity = stableListingIdentity(event);
      const open = (openByAsset.get(key) ?? []).filter(
        (listing) => listing.status === "active" && listing.openedAtMs <= timestamp,
      );
      const sameIdentity =
        identity === undefined
          ? []
          : open.filter((listing) => listing.listingIdentity === identity);
      if (sameIdentity.length === 1) {
        const previous = sameIdentity[0];
        const priceScale = Math.max(1, previous.askTon, askTon);
        if (Math.abs(previous.askTon - askTon) <= priceScale * 1e-12) {
          // A same-price confirmation extends observation of the same listing.
          previous.lastObservedAt = event.eventAt!;
          continue;
        }
        // A price change is a new exposure. Closing and reopening avoids
        // attributing the whole historic duration to the latest asking price.
        previous.status = "cancelled";
        previous.endedAt = event.eventAt!;
        previous.lastObservedAt = event.eventAt!;
        openByAsset.set(
          key,
          (openByAsset.get(key) ?? []).filter((candidate) => candidate !== previous),
        );
        repricedListingCount++;
      } else if (sameIdentity.length > 1) {
        // Corrupt duplicate active identities cannot be repaired safely.
        invalidListingCount++;
        continue;
      }

      const sameMarket = open.filter(
        (listing) =>
          listing.status === "active" &&
          listing.marketSource === event.provenance.source,
      );
      if (sameMarket.length === 1) {
        // Without a shared upstream listing id, a new listing action for the
        // same asset in the same market is treated as a re-price/re-list. Close
        // the previous exposure at the update boundary so subsequent outcomes
        // are not permanently ambiguous.
        const replaced = sameMarket[0];
        replaced.status = "cancelled";
        replaced.endedAt = event.eventAt!;
        replaced.lastObservedAt = event.eventAt!;
        openByAsset.set(
          key,
          (openByAsset.get(key) ?? []).filter((candidate) => candidate !== replaced),
        );
        repricedListingCount++;
      }
      const listing: MutableListing = {
        id: event.eventId,
        username: event.username,
        status: "active",
        askTon,
        listedAt: event.eventAt!,
        // A listing action alone proves existence only at its event time. Do
        // not treat the later collection time as continuous active follow-up.
        lastObservedAt: event.eventAt!,
        assetKey: key,
        openedAtMs: timestamp,
        marketSource: event.provenance.source,
        ...(identity === undefined ? {} : { listingIdentity: identity }),
      };
      listings.push(listing);
      const currentOpen = openByAsset.get(key) ?? [];
      currentOpen.push(listing);
      openByAsset.set(key, currentOpen);
      continue;
    }

    if (
      event.eventType !== "sale" &&
      event.eventType !== "cancelled" &&
      event.eventType !== "expired" &&
      event.eventType !== "transfer"
    ) {
      continue;
    }

    const allCompatible = (openByAsset.get(key) ?? []).filter(
      (listing) => listing.status === "active" && listing.openedAtMs <= timestamp,
    );
    const identity = stableListingIdentity(event);
    const identityMatches =
      identity === undefined
        ? []
        : allCompatible.filter((listing) => listing.listingIdentity === identity);
    const sameMarket = allCompatible.filter(
      (listing) => listing.marketSource === event.provenance.source,
    );
    const compatible =
      identityMatches.length > 0
        ? identityMatches
        : sameMarket.length > 0
          ? sameMarket
          : allCompatible;
    if (compatible.length === 0) {
      unmatchedTerminalCount++;
      continue;
    }
    if (compatible.length !== 1) {
      ambiguousTerminalCount++;
      continue;
    }

    const listing = compatible[0];
    listing.status =
      event.eventType === "sale"
        ? "sold"
        : event.eventType === "transfer"
          ? "cancelled"
          : event.eventType;
    listing.endedAt = event.eventAt!;
    // An unambiguous terminal event closes the observable lifecycle. When a
    // historical valuation predates it, the estimator caps this at valuationAt.
    listing.lastObservedAt = event.eventAt!;
    if (event.eventType === "sale") {
      listing.soldAt = event.eventAt!;
      listing.salePriceTon = event.priceTon;
    }
    openByAsset.set(
      key,
      (openByAsset.get(key) ?? []).filter((candidate) => candidate !== listing),
    );
    matchedTerminalCount++;
  }

  const observations = listings.map(
    ({
      assetKey: _assetKey,
      openedAtMs: _openedAtMs,
      marketSource: _marketSource,
      listingIdentity: _listingIdentity,
      ...observation
    }) =>
      Object.freeze({ ...observation }),
  );
  return {
    observations,
    diagnostics: {
      inputEventCount: events.length,
      exactDatedEventCount,
      listingEventCount,
      observationCount: observations.length,
      matchedTerminalCount,
      unmatchedTerminalCount,
      ambiguousTerminalCount,
      invalidListingCount,
      repricedListingCount,
    },
  };
}

export function estimateLiquidityFromMarketEvents(
  target: string | LiquidityTarget,
  events: readonly MarketEvent[],
  valuationAt: LiquidityTimestamp,
  options: LiquidityEstimatorOptions = {},
): MarketLiquidityEstimate {
  const built = marketEventsToLiquidityListings(events);
  return {
    estimate: estimateLiquidity(target, built.observations, valuationAt, options),
    buildDiagnostics: built.diagnostics,
  };
}
