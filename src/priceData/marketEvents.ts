import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../storage/atomic.js";

export const DEFAULT_MARKET_EVENTS_PATH = "data/market-events.json";
export const MARKET_EVENT_SCHEMA_VERSION = 1 as const;
export const MARKET_EVENT_IDENTITY_KINDS = [
  "event",
  "observation-cluster",
] as const;
export type MarketEventIdentityKind =
  (typeof MARKET_EVENT_IDENTITY_KINDS)[number];

export const MARKET_EVENT_TYPES = [
  "sale",
  "listed",
  "bid",
  "cancelled",
  "expired",
  "transfer",
  "mint",
] as const;
export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number];

export const SALE_FORMATS = ["auction", "fixed-price", "offer", "unknown"] as const;
export type SaleFormat = (typeof SALE_FORMATS)[number];

export const MARKET_PHASES = ["primary", "secondary", "unknown"] as const;
export type MarketPhase = (typeof MARKET_PHASES)[number];

export const MARKET_EVENT_CONFIDENCE = ["high", "medium", "low"] as const;
export type MarketEventConfidence = (typeof MARKET_EVENT_CONFIDENCE)[number];

export type CounterpartyRole = "seller" | "buyer" | "bidder" | "from" | "to" | "owner";
export type CounterpartyHash = `sha256:${string}`;

export interface HashedCounterparties {
  readonly seller?: CounterpartyHash;
  readonly buyer?: CounterpartyHash;
  readonly bidder?: CounterpartyHash;
  readonly from?: CounterpartyHash;
  readonly to?: CounterpartyHash;
  readonly owner?: CounterpartyHash;
}

export interface MarketEventProvenance {
  /** Extensible lowercase slug, e.g. fragment, toncenter, tonapi or dune. */
  readonly source: string;
  readonly parser?: string;
  readonly sourceUrl?: string;
  readonly requestedUrl?: string;
  /** Canonical asset/detail page; distinct from the listing page request. */
  readonly assetUrl?: string;
  readonly page?: number;
  readonly rowIndex?: number;
  readonly marketView?: string;
  /** Stable id assigned by the source, when one exists. */
  readonly sourceEventId?: string;
  /** Hash of the raw evidence/snapshot, never the raw payload itself. */
  readonly snapshotHash?: CounterpartyHash;
}

export interface MarketEvent {
  readonly schemaVersion: typeof MARKET_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  /** Distinguishes an immutable occurrence from deduplicated uncertain evidence. */
  readonly identityKind: MarketEventIdentityKind;
  readonly eventType: MarketEventType;
  readonly username: string;
  /**
   * Exact market/blockchain event time. It is intentionally optional and must
   * never be synthesized from the observation time.
   */
  readonly eventAt?: string;
  /** Time at which this evidence was collected. Always required. */
  readonly observedAt: string;
  readonly priceTon?: number;
  readonly askTon?: number;
  readonly reserveTon?: number;
  readonly bidTon?: number;
  readonly feesTon?: number;
  readonly saleFormat: SaleFormat;
  readonly marketPhase: MarketPhase;
  readonly txHash?: string;
  readonly nftItemAddress?: string;
  readonly nftCollectionAddress?: string;
  readonly counterparties?: HashedCounterparties;
  readonly provenance: MarketEventProvenance;
  readonly confidence: MarketEventConfidence;
}

/**
 * Structural input compatible with both the original three-field SoldRecord
 * and its enriched form. Keeping this local avoids a runtime dependency on
 * soldHistory.ts (and therefore on its HTML parser dependencies).
 */
export interface SoldRecordLike {
  readonly username: string;
  readonly priceTon: number;
  readonly scrapedAt: string;
  readonly saleAt?: string;
  readonly source?: string;
  readonly view?: string;
  readonly confidence?: string;
  readonly eventId?: string;
  readonly provenance?: {
    readonly parser?: string;
    readonly sourceUrl?: string;
    readonly requestedUrl?: string;
    readonly assetUrl?: string;
    readonly page?: number;
    readonly rowIndex?: number;
  };
}

export interface MarketEventIdentityInput {
  readonly eventType: MarketEventType;
  readonly username: string;
  readonly eventAt?: string;
  readonly observedAt: string;
  readonly priceTon?: number;
  readonly askTon?: number;
  readonly reserveTon?: number;
  readonly bidTon?: number;
  readonly feesTon?: number;
  readonly saleFormat?: SaleFormat;
  readonly marketPhase?: MarketPhase;
  readonly txHash?: string;
  readonly nftItemAddress?: string;
  readonly nftCollectionAddress?: string;
  readonly counterparties?: HashedCounterparties;
  readonly provenance: Pick<MarketEventProvenance, "source"> &
    Partial<Pick<MarketEventProvenance, "sourceEventId">>;
}

export type MarketEventValidationResult =
  | { readonly ok: true; readonly event: MarketEvent }
  | { readonly ok: false; readonly errors: readonly string[] };

const EVENT_TYPE_SET = new Set<string>(MARKET_EVENT_TYPES);
const SALE_FORMAT_SET = new Set<string>(SALE_FORMATS);
const MARKET_PHASE_SET = new Set<string>(MARKET_PHASES);
const CONFIDENCE_SET = new Set<string>(MARKET_EVENT_CONFIDENCE);
const IDENTITY_KIND_SET = new Set<string>(MARKET_EVENT_IDENTITY_KINDS);
const COUNTERPARTY_ROLES: readonly CounterpartyRole[] = [
  "seller",
  "buyer",
  "bidder",
  "from",
  "to",
  "owner",
];
const COUNTERPARTY_ROLE_SET = new Set<string>(COUNTERPARTY_ROLES);

const USERNAME_RE = /^[a-z][a-z0-9_]{3,31}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,239}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PARSER_RE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const COUNTERPARTY_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const TX_HASH_RE = /^[A-Za-z0-9+/_=-]{16,128}$/;
const RAW_TON_ADDRESS_RE = /^-?\d+:[a-f0-9]{64}$/;
const FRIENDLY_TON_ADDRESS_RE = /^[A-Za-z0-9_-]{48}$/;

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "eventId",
  "identityKind",
  "eventType",
  "username",
  "eventAt",
  "observedAt",
  "priceTon",
  "askTon",
  "reserveTon",
  "bidTon",
  "feesTon",
  "saleFormat",
  "marketPhase",
  "txHash",
  "nftItemAddress",
  "nftCollectionAddress",
  "counterparties",
  "provenance",
  "confidence",
]);
const PROVENANCE_FIELDS = new Set([
  "source",
  "parser",
  "sourceUrl",
  "requestedUrl",
  "assetUrl",
  "page",
  "rowIndex",
  "marketView",
  "sourceEventId",
  "snapshotHash",
]);
const FORBIDDEN_RAW_COUNTERPARTY_FIELDS = [
  "seller",
  "buyer",
  "bidder",
  "owner",
  "from",
  "to",
  "sellerAddress",
  "buyerAddress",
  "bidderAddress",
  "ownerAddress",
  "fromAddress",
  "toAddress",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().replace(/^@+/, "").toLowerCase();
  return USERNAME_RE.test(username) ? username : null;
}

function normalizedPositiveAmount(
  value: unknown,
  field: string,
  errors: string[],
  allowZero = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    errors.push(`${field} must be a finite ${allowZero ? "non-negative" : "positive"} number.`);
    return undefined;
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizedOptionalText(
  value: unknown,
  field: string,
  errors: string[],
  maxLength: number,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    (pattern !== undefined && !pattern.test(normalized))
  ) {
    errors.push(`${field} has an invalid format.`);
    return undefined;
  }
  return normalized;
}

function normalizedUrl(
  value: unknown,
  field: string,
  errors: string[],
): string | undefined {
  const text = normalizedOptionalText(value, field, errors, 2_048);
  if (text === undefined) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${field} must use http or https.`);
      return undefined;
    }
    return url.toString();
  } catch {
    errors.push(`${field} must be a valid URL.`);
    return undefined;
  }
}

function normalizedTonAddress(
  value: unknown,
  field: string,
  errors: string[],
): string | undefined {
  const address = normalizedOptionalText(value, field, errors, 128);
  if (address === undefined) return undefined;
  const raw = address.toLowerCase();
  if (RAW_TON_ADDRESS_RE.test(raw)) return raw;
  if (FRIENDLY_TON_ADDRESS_RE.test(address)) return address;
  errors.push(`${field} must be a raw or friendly TON address.`);
  return undefined;
}

function normalizeCounterparties(
  value: unknown,
  errors: string[],
): HashedCounterparties | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push("counterparties must be an object.");
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!COUNTERPARTY_ROLE_SET.has(field)) {
      errors.push(`counterparties.${field} is not supported.`);
    }
  }

  const counterparties: Partial<Record<CounterpartyRole, CounterpartyHash>> = {};
  for (const role of COUNTERPARTY_ROLES) {
    const raw = value[role];
    if (raw === undefined) continue;
    const hash = normalizedOptionalText(
      raw,
      `counterparties.${role}`,
      errors,
      71,
      COUNTERPARTY_HASH_RE,
    );
    if (hash !== undefined) counterparties[role] = hash as CounterpartyHash;
  }
  if (Object.keys(counterparties).length === 0) return undefined;
  return Object.freeze({ ...counterparties });
}

function normalizeProvenance(
  value: unknown,
  errors: string[],
): MarketEventProvenance | null {
  if (!isObject(value)) {
    errors.push("provenance must be an object.");
    return null;
  }
  for (const field of Object.keys(value)) {
    if (!PROVENANCE_FIELDS.has(field)) {
      errors.push(`provenance.${field} is not supported.`);
    }
  }

  const sourceRaw = typeof value.source === "string" ? value.source.trim().toLowerCase() : "";
  if (!SOURCE_RE.test(sourceRaw)) errors.push("provenance.source has an invalid format.");

  const parserRaw =
    typeof value.parser === "string" ? value.parser.trim().toLowerCase() : value.parser;
  const parser = normalizedOptionalText(
    parserRaw,
    "provenance.parser",
    errors,
    128,
    PARSER_RE,
  );
  const sourceUrl = normalizedUrl(value.sourceUrl, "provenance.sourceUrl", errors);
  const requestedUrl = normalizedUrl(
    value.requestedUrl,
    "provenance.requestedUrl",
    errors,
  );
  const assetUrl = normalizedUrl(value.assetUrl, "provenance.assetUrl", errors);
  const marketView = normalizedOptionalText(
    typeof value.marketView === "string" ? value.marketView.toLowerCase() : value.marketView,
    "provenance.marketView",
    errors,
    120,
    /^[a-z0-9][a-z0-9._-]{0,119}$/,
  );
  const sourceEventId = normalizedOptionalText(
    value.sourceEventId,
    "provenance.sourceEventId",
    errors,
    240,
    /^[^\u0000-\u001f\u007f]+$/,
  );
  const snapshotHash = normalizedOptionalText(
    value.snapshotHash,
    "provenance.snapshotHash",
    errors,
    71,
    COUNTERPARTY_HASH_RE,
  );

  let page: number | undefined;
  if (value.page !== undefined) {
    if (!Number.isSafeInteger(value.page) || (value.page as number) <= 0) {
      errors.push("provenance.page must be a positive safe integer.");
    } else {
      page = value.page as number;
    }
  }
  let rowIndex: number | undefined;
  if (value.rowIndex !== undefined) {
    if (!Number.isSafeInteger(value.rowIndex) || (value.rowIndex as number) < 0) {
      errors.push("provenance.rowIndex must be a non-negative safe integer.");
    } else {
      rowIndex = value.rowIndex as number;
    }
  }

  if (!SOURCE_RE.test(sourceRaw)) return null;
  return Object.freeze({
    source: sourceRaw,
    ...(parser === undefined ? {} : { parser }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(requestedUrl === undefined ? {} : { requestedUrl }),
    ...(assetUrl === undefined ? {} : { assetUrl }),
    ...(page === undefined ? {} : { page }),
    ...(rowIndex === undefined ? {} : { rowIndex }),
    ...(marketView === undefined ? {} : { marketView }),
    ...(sourceEventId === undefined ? {} : { sourceEventId }),
    ...(snapshotHash === undefined
      ? {}
      : { snapshotHash: snapshotHash as CounterpartyHash }),
  });
}

/**
 * Generates a stable identity key.
 *
 * Without an exact time or upstream identity this is explicitly an uncertain
 * observation-cluster key, not a claim that an exact sale occurrence is
 * known. Mutable collection time and observed prices must not create a new
 * pseudo-event every time the same legacy row is scraped.
 */
export function buildMarketEventId(input: MarketEventIdentityInput): string {
  const username = normalizeUsername(input.username);
  const observedAt = canonicalTimestamp(input.observedAt);
  const eventAt =
    input.eventAt === undefined ? undefined : canonicalTimestamp(input.eventAt);
  const source = input.provenance.source.trim().toLowerCase();
  if (
    username === null ||
    observedAt === null ||
    (input.eventAt !== undefined && eventAt === null) ||
    !EVENT_TYPE_SET.has(input.eventType) ||
    !SOURCE_RE.test(source)
  ) {
    throw new RangeError("Cannot build an event id from invalid identity fields.");
  }

  const stableOccurrence =
    input.provenance.sourceEventId !== undefined
      ? `source-event:${input.provenance.sourceEventId.trim()}`
      : input.txHash !== undefined
        ? `tx:${input.txHash.trim()}`
        : null;
  const occurrence = stableOccurrence ?? (eventAt !== undefined ? `event:${eventAt}` : null);
  // Stable source/transaction ids are ideal. When neither exists, an exact
  // event timestamp is the immutable occurrence boundary. Fields discovered
  // during later enrichment (fees, market metadata, NFT addresses and
  // counterparties) deliberately never participate in the id: otherwise the
  // same occurrence would be duplicated instead of merged.
  const canonical = (
    occurrence === null
      ? ["market-observation-cluster-v1", source, input.eventType, username]
      : ["market-event-v1", source, input.eventType, username, occurrence]
  ).join("\u0000");
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 40);
  return `market:v1:${digest}`;
}

/** Hashes a wallet/account identifier before it enters the warehouse. */
export function hashCounterparty(identifier: string, namespace = "global"): CounterpartyHash {
  const normalized = identifier.trim();
  const normalizedNamespace = namespace.trim();
  if (normalized.length === 0 || normalizedNamespace.length === 0) {
    throw new RangeError("Counterparty identifier and namespace must be non-empty.");
  }
  const digest = createHash("sha256")
    .update(`market-counterparty-v1\u0000${normalizedNamespace}\u0000${normalized}`)
    .digest("hex");
  return `sha256:${digest}`;
}

function freezeEvent(event: MarketEvent): MarketEvent {
  const provenance = Object.freeze({ ...event.provenance });
  const counterparties =
    event.counterparties === undefined
      ? undefined
      : Object.freeze({ ...event.counterparties });
  return Object.freeze({
    ...event,
    provenance,
    ...(counterparties === undefined ? {} : { counterparties }),
  });
}

function failed(errors: string[]): MarketEventValidationResult {
  return Object.freeze({
    ok: false as const,
    errors: Object.freeze([...errors]),
  });
}

/**
 * Strictly validates and canonicalizes an unknown event. Unknown fields,
 * un-hashed counterparties and type-incompatible price fields are rejected.
 */
export function validateMarketEvent(value: unknown): MarketEventValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return failed(["event must be an object."]);

  for (const field of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS.has(field)) errors.push(`${field} is not supported.`);
  }
  for (const field of FORBIDDEN_RAW_COUNTERPARTY_FIELDS) {
    if (field in value) {
      errors.push(`${field} is forbidden; store only a hash inside counterparties.`);
    }
  }

  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== MARKET_EVENT_SCHEMA_VERSION
  ) {
    errors.push(`schemaVersion must be ${MARKET_EVENT_SCHEMA_VERSION}.`);
  }

  const eventType =
    typeof value.eventType === "string" && EVENT_TYPE_SET.has(value.eventType)
      ? (value.eventType as MarketEventType)
      : null;
  if (eventType === null) errors.push("eventType is invalid.");

  const username = normalizeUsername(value.username);
  if (username === null) errors.push("username is invalid.");

  const observedAt = canonicalTimestamp(value.observedAt);
  if (observedAt === null) errors.push("observedAt must be a valid timestamp.");

  let eventAt: string | undefined;
  if (value.eventAt !== undefined && value.eventAt !== null) {
    const parsed = canonicalTimestamp(value.eventAt);
    if (parsed === null) {
      errors.push("eventAt must be a valid exact timestamp when present.");
    } else {
      eventAt = parsed;
    }
  }
  if (
    eventAt !== undefined &&
    observedAt !== null &&
    Date.parse(eventAt) > Date.parse(observedAt)
  ) {
    errors.push("eventAt cannot be later than observedAt.");
  }

  const priceTon = normalizedPositiveAmount(value.priceTon, "priceTon", errors);
  const askTon = normalizedPositiveAmount(value.askTon, "askTon", errors);
  const reserveTon = normalizedPositiveAmount(value.reserveTon, "reserveTon", errors);
  const bidTon = normalizedPositiveAmount(value.bidTon, "bidTon", errors);
  const feesTon = normalizedPositiveAmount(value.feesTon, "feesTon", errors, true);

  const saleFormat =
    value.saleFormat === undefined
      ? "unknown"
      : typeof value.saleFormat === "string" && SALE_FORMAT_SET.has(value.saleFormat)
        ? (value.saleFormat as SaleFormat)
        : null;
  if (saleFormat === null) errors.push("saleFormat is invalid.");

  const marketPhase =
    value.marketPhase === undefined
      ? "unknown"
      : typeof value.marketPhase === "string" && MARKET_PHASE_SET.has(value.marketPhase)
        ? (value.marketPhase as MarketPhase)
        : null;
  if (marketPhase === null) errors.push("marketPhase is invalid.");

  const confidence =
    typeof value.confidence === "string" && CONFIDENCE_SET.has(value.confidence)
      ? (value.confidence as MarketEventConfidence)
      : null;
  if (confidence === null) errors.push("confidence is invalid.");

  const txHash = normalizedOptionalText(value.txHash, "txHash", errors, 128, TX_HASH_RE);
  const nftItemAddress = normalizedTonAddress(
    value.nftItemAddress,
    "nftItemAddress",
    errors,
  );
  const nftCollectionAddress = normalizedTonAddress(
    value.nftCollectionAddress,
    "nftCollectionAddress",
    errors,
  );
  const counterparties = normalizeCounterparties(value.counterparties, errors);
  const provenance = normalizeProvenance(value.provenance, errors);
  const suppliedIdentityKind =
    value.identityKind === undefined
      ? undefined
      : typeof value.identityKind === "string" && IDENTITY_KIND_SET.has(value.identityKind)
        ? (value.identityKind as MarketEventIdentityKind)
        : null;
  if (suppliedIdentityKind === null) errors.push("identityKind is invalid.");
  const identityKind: MarketEventIdentityKind =
    eventAt !== undefined || txHash !== undefined || provenance?.sourceEventId !== undefined
      ? "event"
      : "observation-cluster";
  if (
    suppliedIdentityKind !== undefined &&
    suppliedIdentityKind !== null &&
    suppliedIdentityKind !== identityKind
  ) {
    errors.push(`identityKind must be ${identityKind} for the supplied evidence.`);
  }

  if (eventType === "sale" && priceTon === undefined) {
    errors.push("sale events require priceTon.");
  }
  if (eventType === "sale" && confidence === "high") {
    if (eventAt === undefined) {
      errors.push("high-confidence sale events require an exact eventAt timestamp.");
    }
    if (txHash === undefined && provenance?.sourceEventId === undefined) {
      errors.push(
        "high-confidence sale events require txHash or provenance.sourceEventId.",
      );
    }
  }
  if (eventType === "listed" && askTon === undefined && reserveTon === undefined) {
    errors.push("listed events require askTon or reserveTon.");
  }
  if (eventType === "bid" && bidTon === undefined) {
    errors.push("bid events require bidTon.");
  }
  if (eventType !== null && eventType !== "sale" && priceTon !== undefined) {
    errors.push("priceTon is allowed only for sale events.");
  }
  if (
    (eventType === "transfer" || eventType === "mint") &&
    (askTon !== undefined || reserveTon !== undefined || bidTon !== undefined)
  ) {
    errors.push(`${eventType} events cannot contain askTon, reserveTon or bidTon.`);
  }
  if (
    saleFormat === "fixed-price" &&
    (reserveTon !== undefined || bidTon !== undefined)
  ) {
    errors.push("fixed-price events cannot contain reserveTon or bidTon.");
  }

  const suppliedEventId = normalizedOptionalText(
    value.eventId,
    "eventId",
    errors,
    240,
    EVENT_ID_RE,
  );

  if (
    errors.length > 0 ||
    eventType === null ||
    username === null ||
    observedAt === null ||
    saleFormat === null ||
    marketPhase === null ||
    provenance === null ||
    confidence === null
  ) {
    return failed(errors);
  }

  const identity: MarketEventIdentityInput & {
    readonly saleFormat: SaleFormat;
    readonly marketPhase: MarketPhase;
  } = {
    eventType,
    username,
    ...(eventAt === undefined ? {} : { eventAt }),
    observedAt,
    ...(priceTon === undefined ? {} : { priceTon }),
    ...(askTon === undefined ? {} : { askTon }),
    ...(reserveTon === undefined ? {} : { reserveTon }),
    ...(bidTon === undefined ? {} : { bidTon }),
    ...(feesTon === undefined ? {} : { feesTon }),
    saleFormat,
    marketPhase,
    ...(txHash === undefined ? {} : { txHash }),
    ...(nftItemAddress === undefined ? {} : { nftItemAddress }),
    ...(nftCollectionAddress === undefined ? {} : { nftCollectionAddress }),
    ...(counterparties === undefined ? {} : { counterparties }),
    provenance,
  };
  const canonicalEventId = buildMarketEventId(identity);
  if (suppliedEventId !== undefined && suppliedEventId !== canonicalEventId) {
    return failed([
      `eventId does not match canonical identity; expected ${canonicalEventId}.`,
    ]);
  }
  const eventId = canonicalEventId;
  const event: MarketEvent = {
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
    eventId,
    identityKind,
    ...identity,
    provenance,
    confidence,
  };
  return Object.freeze({ ok: true as const, event: freezeEvent(event) });
}

export function normalizeMarketEvent(value: unknown): MarketEvent | null {
  const result = validateMarketEvent(value);
  return result.ok ? result.event : null;
}

function requireMarketEvent(value: unknown, context: string): MarketEvent {
  const result = validateMarketEvent(value);
  if (result.ok) return result.event;
  throw new TypeError(`${context}: ${result.errors.join(" ")}`);
}

function sameNumber(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-12;
}

function mergeOptionalScalar<T extends string | number>(
  eventId: string,
  field: string,
  left: T | undefined,
  right: T | undefined,
): T | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const equal =
    typeof left === "number" && typeof right === "number"
      ? sameNumber(left, right)
      : left === right;
  if (!equal) {
    throw new Error(`Conflicting ${field} for market event ${eventId}.`);
  }
  return left;
}

function mergeKnownEnum<T extends string>(
  eventId: string,
  field: string,
  left: T,
  right: T,
): T {
  if (left === right) return left;
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  throw new Error(`Conflicting ${field} for market event ${eventId}.`);
}

function provenanceScore(value: MarketEventProvenance): number {
  return Object.values(value).filter((field) => field !== undefined).length;
}

function canonicalProvenance(value: MarketEventProvenance): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => compareText(left, right)),
    ),
  );
}

function chooseProvenance(
  eventId: string,
  left: MarketEventProvenance,
  right: MarketEventProvenance,
): MarketEventProvenance {
  if (left.source !== right.source) {
    throw new Error(`Conflicting provenance.source for market event ${eventId}.`);
  }
  const leftScore = provenanceScore(left);
  const rightScore = provenanceScore(right);
  if (leftScore !== rightScore) return leftScore > rightScore ? left : right;
  return compareText(canonicalProvenance(left), canonicalProvenance(right)) <= 0
    ? left
    : right;
}

function mergeCounterparties(
  eventId: string,
  left: HashedCounterparties | undefined,
  right: HashedCounterparties | undefined,
): HashedCounterparties | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const merged: Partial<Record<CounterpartyRole, CounterpartyHash>> = {};
  for (const role of COUNTERPARTY_ROLES) {
    const value = mergeOptionalScalar(eventId, `counterparties.${role}`, left[role], right[role]);
    if (value !== undefined) merged[role] = value;
  }
  return Object.freeze({ ...merged });
}

function mergeSameEvent(left: MarketEvent, right: MarketEvent): MarketEvent {
  const eventId = left.eventId;
  if (eventId !== right.eventId) {
    throw new Error("Cannot merge market events with different event ids.");
  }
  const eventType = mergeOptionalScalar(
    eventId,
    "eventType",
    left.eventType,
    right.eventType,
  )!;
  const username = mergeOptionalScalar(eventId, "username", left.username, right.username)!;
  const identityKind = mergeOptionalScalar(
    eventId,
    "identityKind",
    left.identityKind,
    right.identityKind,
  )!;
  const observationCluster = identityKind === "observation-cluster";
  const latestObservation =
    Date.parse(right.observedAt) >= Date.parse(left.observedAt) ? right : left;
  const olderObservation = latestObservation === right ? left : right;
  const latestObservedValue = <T>(
    select: (event: MarketEvent) => T | undefined,
  ): T | undefined => select(latestObservation) ?? select(olderObservation);
  const eventAt = mergeOptionalScalar(eventId, "eventAt", left.eventAt, right.eventAt);
  const priceTon = observationCluster
    ? latestObservedValue((event) => event.priceTon)
    : mergeOptionalScalar(eventId, "priceTon", left.priceTon, right.priceTon);
  const askTon = observationCluster
    ? latestObservedValue((event) => event.askTon)
    : mergeOptionalScalar(eventId, "askTon", left.askTon, right.askTon);
  const reserveTon = observationCluster
    ? latestObservedValue((event) => event.reserveTon)
    : mergeOptionalScalar(eventId, "reserveTon", left.reserveTon, right.reserveTon);
  const bidTon = observationCluster
    ? latestObservedValue((event) => event.bidTon)
    : mergeOptionalScalar(eventId, "bidTon", left.bidTon, right.bidTon);
  const feesTon = observationCluster
    ? latestObservedValue((event) => event.feesTon)
    : mergeOptionalScalar(eventId, "feesTon", left.feesTon, right.feesTon);
  const txHash = mergeOptionalScalar(eventId, "txHash", left.txHash, right.txHash);
  const nftItemAddress = mergeOptionalScalar(
    eventId,
    "nftItemAddress",
    left.nftItemAddress,
    right.nftItemAddress,
  );
  const nftCollectionAddress = mergeOptionalScalar(
    eventId,
    "nftCollectionAddress",
    left.nftCollectionAddress,
    right.nftCollectionAddress,
  );
  const saleFormat = mergeKnownEnum(
    eventId,
    "saleFormat",
    left.saleFormat,
    right.saleFormat,
  );
  const marketPhase = mergeKnownEnum(
    eventId,
    "marketPhase",
    left.marketPhase,
    right.marketPhase,
  );
  const confidenceRank: Record<MarketEventConfidence, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  const confidence =
    confidenceRank[left.confidence] >= confidenceRank[right.confidence]
      ? left.confidence
      : right.confidence;
  const observedAt = observationCluster
    ? latestObservation.observedAt
    : Date.parse(left.observedAt) <= Date.parse(right.observedAt)
      ? left.observedAt
      : right.observedAt;
  const counterparties = mergeCounterparties(
    eventId,
    left.counterparties,
    right.counterparties,
  );

  return requireMarketEvent(
    {
      schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
      eventId,
      identityKind,
      eventType,
      username,
      ...(eventAt === undefined ? {} : { eventAt }),
      observedAt,
      ...(priceTon === undefined ? {} : { priceTon }),
      ...(askTon === undefined ? {} : { askTon }),
      ...(reserveTon === undefined ? {} : { reserveTon }),
      ...(bidTon === undefined ? {} : { bidTon }),
      ...(feesTon === undefined ? {} : { feesTon }),
      saleFormat,
      marketPhase,
      ...(txHash === undefined ? {} : { txHash }),
      ...(nftItemAddress === undefined ? {} : { nftItemAddress }),
      ...(nftCollectionAddress === undefined ? {} : { nftCollectionAddress }),
      ...(counterparties === undefined ? {} : { counterparties }),
      provenance: chooseProvenance(eventId, left.provenance, right.provenance),
      confidence,
    },
    `Merged market event ${eventId} is invalid`,
  );
}

function effectiveTime(event: MarketEvent): number {
  return Date.parse(event.eventAt ?? event.observedAt);
}

/**
 * Immutable event-id merge. Repeated sales survive because their occurrence
 * time/transaction produces distinct ids. Conflicting payloads for one id
 * throw instead of silently overwriting evidence.
 */
export function mergeMarketEvents(
  existing: readonly MarketEvent[],
  incoming: readonly MarketEvent[],
): readonly MarketEvent[] {
  const byId = new Map<string, MarketEvent>();
  for (const [index, raw] of [...existing, ...incoming].entries()) {
    const event = requireMarketEvent(raw, `Invalid market event at index ${index}`);
    const previous = byId.get(event.eventId);
    byId.set(event.eventId, previous === undefined ? event : mergeSameEvent(previous, event));
  }
  const merged = [...byId.values()].sort(
    (left, right) =>
      effectiveTime(left) - effectiveTime(right) ||
      Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
      compareText(left.eventId, right.eventId),
  );
  return Object.freeze(merged);
}

/**
 * Converts a legacy SoldRecord into a sale event. `scrapedAt` remains only
 * observedAt; eventAt is populated exclusively from an exact saleAt.
 */
export function soldRecordToMarketEvent(record: SoldRecordLike): MarketEvent | null {
  if (!isObject(record)) return null;
  const provenance = record.provenance;
  const source =
    typeof record.source === "string" && SOURCE_RE.test(record.source.trim().toLowerCase())
      ? record.source.trim().toLowerCase()
      : "fragment";
  const confidence: MarketEventConfidence =
    record.saleAt === undefined
      ? "low"
      : typeof record.confidence === "string" &&
          CONFIDENCE_SET.has(record.confidence) &&
          (record.confidence !== "high" || record.eventId !== undefined)
        ? (record.confidence as MarketEventConfidence)
        : "medium";

  return normalizeMarketEvent({
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
    eventType: "sale",
    username: record.username,
    ...(record.saleAt === undefined ? {} : { eventAt: record.saleAt }),
    observedAt: record.scrapedAt,
    priceTon: record.priceTon,
    saleFormat: "unknown",
    marketPhase: "unknown",
    provenance: {
      source,
      parser:
        typeof provenance?.parser === "string"
          ? provenance.parser
          : "legacy-sold-record",
      ...(typeof provenance?.sourceUrl === "string"
        ? { sourceUrl: provenance.sourceUrl }
        : {}),
      ...(typeof provenance?.requestedUrl === "string"
        ? { requestedUrl: provenance.requestedUrl }
        : {}),
      ...(typeof provenance?.assetUrl === "string"
        ? { assetUrl: provenance.assetUrl }
        : {}),
      ...(provenance?.page === undefined ? {} : { page: provenance.page }),
      ...(provenance?.rowIndex === undefined ? {} : { rowIndex: provenance.rowIndex }),
      ...(typeof record.view === "string" ? { marketView: record.view } : {}),
      ...(record.eventId === undefined ? {} : { sourceEventId: record.eventId }),
    },
    confidence,
  });
}

export function migrateSoldRecords(
  records: readonly SoldRecordLike[],
): readonly MarketEvent[] {
  const converted = records
    .map(soldRecordToMarketEvent)
    .filter((event): event is MarketEvent => event !== null);
  return mergeMarketEvents([], converted);
}

function emptyEvents(): readonly MarketEvent[] {
  return Object.freeze([]);
}

export class MarketEventWarehouseError extends Error {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = "MarketEventWarehouseError";
  }
}

/**
 * Loads either a market-event array/envelope or a legacy SoldRecord array.
 * Any structural/row corruption fails closed and leaves the source file
 * untouched. Returning an empty array is reserved for a genuinely missing or
 * valid empty warehouse, so callers cannot accidentally overwrite evidence
 * after mistaking a read failure for "no data".
 */
export function loadMarketEvents(path = DEFAULT_MARKET_EVENTS_PATH): readonly MarketEvent[] {
  if (!existsSync(path)) return emptyEvents();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new MarketEventWarehouseError(
      path,
      `cannot read valid JSON (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.events)
      ? parsed.events
      : null;
  if (rows === null) {
    throw new MarketEventWarehouseError(
      path,
      "expected an event array or { events: [] } envelope",
    );
  }

  const byId = new Map<string, MarketEvent>();
  const rejectionDetails: string[] = [];
  for (const [index, row] of rows.entries()) {
    let event: MarketEvent | null = null;
    if (isObject(row) && "eventType" in row) {
      const validation = validateMarketEvent(row);
      if (validation.ok) event = validation.event;
      else rejectionDetails.push(`row ${index}: ${validation.errors.join(" ")}`);
    } else if (isObject(row)) {
      event = soldRecordToMarketEvent(row as unknown as SoldRecordLike);
      if (event === null) rejectionDetails.push(`row ${index}: invalid legacy sold record`);
    } else {
      rejectionDetails.push(`row ${index}: record must be an object`);
    }
    if (event === null) continue;

    const previous = byId.get(event.eventId);
    if (previous === undefined) {
      byId.set(event.eventId, event);
      continue;
    }
    try {
      byId.set(event.eventId, mergeSameEvent(previous, event));
    } catch (error) {
      rejectionDetails.push(
        `row ${index}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (rejectionDetails.length > 0) {
    const details = rejectionDetails.slice(0, 5).join(" | ");
    const remainder =
      rejectionDetails.length > 5
        ? ` | and ${rejectionDetails.length - 5} more`
        : "";
    throw new MarketEventWarehouseError(
      path,
      `refusing partial load of ${rejectionDetails.length} invalid/conflicting record(s): ${details}${remainder}`,
    );
  }
  return mergeMarketEvents([], [...byId.values()]);
}

export function saveMarketEvents(
  events: readonly MarketEvent[],
  path = DEFAULT_MARKET_EVENTS_PATH,
): void {
  const normalized = mergeMarketEvents([], events);
  // Validate an existing target before atomic replacement. A corrupt file is
  // evidence that needs operator attention, not permission to reset history.
  if (existsSync(path)) loadMarketEvents(path);
  writeJsonAtomic(path, normalized);
}
