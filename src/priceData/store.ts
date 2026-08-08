import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../storage/atomic.js";
import type {
  SoldRecord,
  SoldRecordConfidence,
  SoldRecordParser,
  SoldRecordProvenance,
} from "./soldHistory.js";

const DATA_DIR = "data";
const STORE_PATH = `${DATA_DIR}/sold-history.json`;

const VALID_PARSERS = new Set<SoldRecordParser>([
  "fragment-sold-table",
  "fragment-embedded-json",
  "fragment-text",
]);
const VALID_CONFIDENCE = new Set<SoldRecordConfidence>(["high", "medium", "low"]);

export class SoldHistoryValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "SoldHistoryValidationError";
  }
}

export class SoldHistoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoldHistoryConflictError";
  }
}

export class SoldHistoryWarehouseError extends Error {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = "SoldHistoryWarehouseError";
  }
}

type SoldRecordNormalizationResult =
  | { ok: true; record: SoldRecord }
  | { ok: false; errors: string[] };

// Keep storage usable as a standalone module (the web-server tests copy it
// into an isolated fixture) while generating the exact same event identity as
// the collector.
function buildExactSoldEventId(
  record: Pick<SoldRecord, "username" | "saleAt" | "source">,
): string {
  if (!record.saleAt) {
    throw new SoldHistoryValidationError(
      "Cannot build an exact sold event id without saleAt.",
    );
  }
  const source = record.source ?? "fragment";
  const username = record.username.toLowerCase();
  const discriminator = `sale:${canonicalTimestamp(record.saleAt) ?? record.saleAt}`;
  const digest = createHash("sha256")
    .update(`${source}\0${username}\0${discriminator}`)
    .digest("hex")
    .slice(0, 32);
  return `${source}:${digest}`;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function optionalHttpUrl(value: unknown): string | undefined {
  const text = optionalString(value, 2_048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function optionalFragmentAssetUrl(value: unknown): string | undefined {
  const normalized = optionalHttpUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "fragment.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/username\/[a-z][a-z0-9_]{3,31}$/.test(url.pathname)
  ) {
    return undefined;
  }
  return url.toString();
}

function normalizeProvenance(value: unknown): SoldRecordProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SoldRecordProvenance>;
  if (
    typeof candidate.parser !== "string" ||
    !VALID_PARSERS.has(candidate.parser as SoldRecordParser)
  ) {
    return undefined;
  }
  const provenance: SoldRecordProvenance = {
    parser: candidate.parser as SoldRecordParser,
  };
  const sourceUrl = optionalHttpUrl(candidate.sourceUrl);
  const requestedUrl = optionalHttpUrl(candidate.requestedUrl);
  const assetUrl = optionalFragmentAssetUrl(candidate.assetUrl);
  if (sourceUrl) provenance.sourceUrl = sourceUrl;
  if (requestedUrl) provenance.requestedUrl = requestedUrl;
  if (assetUrl) provenance.assetUrl = assetUrl;
  if (Number.isSafeInteger(candidate.page) && (candidate.page ?? 0) > 0) {
    provenance.page = candidate.page;
  }
  if (Number.isSafeInteger(candidate.rowIndex) && (candidate.rowIndex ?? -1) >= 0) {
    provenance.rowIndex = candidate.rowIndex;
  }
  return provenance;
}

function normalizeSoldRecord(value: unknown): SoldRecordNormalizationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["record must be an object"] };
  }
  const candidate = value as Partial<SoldRecord>;
  const errors: string[] = [];
  const username =
    typeof candidate.username === "string" ? candidate.username.toLowerCase() : null;
  if (username === null || !/^[a-z][a-z0-9_]{3,31}$/.test(username)) {
    errors.push("username is invalid");
  }
  if (
    typeof candidate.priceTon !== "number" ||
    !Number.isFinite(candidate.priceTon) ||
    candidate.priceTon <= 0
  ) {
    errors.push("priceTon must be a positive finite number");
  }
  const scrapedAt = canonicalTimestamp(candidate.scrapedAt);
  if (!scrapedAt) errors.push("scrapedAt must be a valid timestamp");

  let saleAt: string | undefined;
  if (candidate.saleAt !== undefined) {
    const parsedSaleAt = canonicalTimestamp(candidate.saleAt);
    if (parsedSaleAt === null) {
      errors.push("saleAt must be a valid timestamp when present");
    } else {
      saleAt = parsedSaleAt;
      if (scrapedAt !== null && Date.parse(saleAt) > Date.parse(scrapedAt)) {
        errors.push("saleAt cannot be later than scrapedAt");
      }
    }
  }
  if (errors.length > 0 || username === null || scrapedAt === null) {
    return { ok: false, errors };
  }

  const record: SoldRecord = {
    username,
    priceTon: candidate.priceTon as number,
    scrapedAt,
  };
  if (saleAt) record.saleAt = saleAt;
  if (candidate.source === "fragment") record.source = candidate.source;
  const view = optionalString(candidate.view, 120);
  if (view) record.view = view.toLowerCase();
  if (
    typeof candidate.confidence === "string" &&
    VALID_CONFIDENCE.has(candidate.confidence as SoldRecordConfidence)
  ) {
    // A collection/observation timestamp is not a sale timestamp. Persisted
    // observation-only rows must remain low-confidence regardless of a legacy
    // label written by older collectors.
    record.confidence = saleAt
      ? (candidate.confidence as SoldRecordConfidence)
      : "low";
  }
  const provenance = normalizeProvenance(candidate.provenance);
  if (provenance) record.provenance = provenance;
  const eventId = optionalString(candidate.eventId, 240);
  if (eventId && record.saleAt) {
    const canonicalEventId = buildExactSoldEventId(record);
    if (eventId !== canonicalEventId) {
      return {
        ok: false,
        errors: [
          `eventId does not match canonical sale identity; expected ${canonicalEventId}`,
        ],
      };
    }
    record.eventId = canonicalEventId;
  } else if (record.saleAt) {
    // Enrich partially migrated event records without inventing saleAt for
    // legacy snapshots where only scrapedAt is known.
    record.eventId = buildExactSoldEventId(record);
  }
  return { ok: true, record };
}

function requireSoldRecord(value: unknown, context: string): SoldRecord {
  const result = normalizeSoldRecord(value);
  if (result.ok) return result.record;
  throw new SoldHistoryValidationError(`${context}: ${result.errors.join("; ")}.`);
}

export function loadSoldHistory(path = STORE_PATH): SoldRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      throw new SoldHistoryWarehouseError(path, "expected a sold-record array");
    }
    const normalized: SoldRecord[] = [];
    const rejected: string[] = [];
    for (const [index, raw] of parsed.entries()) {
      const result = normalizeSoldRecord(raw);
      if (result.ok) {
        normalized.push(result.record);
      } else {
        rejected.push(`row ${index}: ${result.errors.join("; ")}`);
      }
    }
    const merged = mergeNormalizedSoldHistory(
      normalized,
      (error) => rejected.push(error.message),
    );
    if (rejected.length > 0) {
      const details = rejected.slice(0, 5).join(" | ");
      const remainder = rejected.length > 5 ? ` | and ${rejected.length - 5} more` : "";
      throw new SoldHistoryWarehouseError(
        path,
        `refusing partial load of ${rejected.length} invalid/conflicting sold record(s): ${details}${remainder}`,
      );
    }
    return merged;
  } catch (error) {
    if (error instanceof SoldHistoryWarehouseError) throw error;
    throw new SoldHistoryWarehouseError(
      path,
      `cannot read valid JSON (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

export function saveSoldHistory(records: SoldRecord[], path = STORE_PATH): void {
  // Saving is a strict boundary: malformed timestamps or conflicting event
  // identities must never be persisted as if they were valid evidence.
  const normalized = mergeSoldHistory([], records);
  // Existing corruption is not equivalent to an empty history. Refuse the
  // replacement so the original bytes remain available for recovery.
  if (existsSync(path)) loadSoldHistory(path);
  writeJsonAtomic(path, normalized);
}

function eventKey(record: SoldRecord): string | null {
  if (record.eventId) return record.eventId;
  return record.saleAt ? buildExactSoldEventId(record) : null;
}

function samePrice(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-12;
}

function conflictingField(
  eventId: string,
  field: string,
  left: string | number,
  right: string | number,
): never {
  throw new SoldHistoryConflictError(
    `Conflicting ${field} for sold event ${eventId}: ${String(left)} != ${String(right)}.`,
  );
}

function mergeObservations(left: SoldRecord, right: SoldRecord): SoldRecord {
  const leftTime = Date.parse(left.scrapedAt);
  const rightTime = Date.parse(right.scrapedAt);
  const newer = rightTime >= leftTime ? right : left;
  const older = newer === right ? left : right;
  const merged: SoldRecord = { ...older, ...newer };
  merged.username = newer.username.toLowerCase();
  merged.saleAt ??= older.saleAt;
  merged.source ??= older.source;
  merged.view ??= older.view;
  merged.provenance ??= older.provenance;
  merged.confidence ??= older.confidence;
  merged.eventId ??= eventKey(newer) ?? eventKey(older) ?? undefined;
  return merged;
}

function mergeSameEvent(left: SoldRecord, right: SoldRecord): SoldRecord {
  const key = eventKey(left) ?? eventKey(right);
  if (key === null) {
    throw new Error("mergeSameEvent requires a stable event identity.");
  }
  if (left.username !== right.username) {
    conflictingField(key, "username", left.username, right.username);
  }
  if (!samePrice(left.priceTon, right.priceTon)) {
    conflictingField(key, "priceTon", left.priceTon, right.priceTon);
  }
  if (left.saleAt !== undefined && right.saleAt !== undefined && left.saleAt !== right.saleAt) {
    conflictingField(key, "saleAt", left.saleAt, right.saleAt);
  }
  if (left.source !== undefined && right.source !== undefined && left.source !== right.source) {
    conflictingField(key, "source", left.source, right.source);
  }
  if (left.eventId !== undefined && right.eventId !== undefined && left.eventId !== right.eventId) {
    conflictingField(key, "eventId", left.eventId, right.eventId);
  }
  return mergeObservations(left, right);
}

/**
 * Event-aware merge.
 *
 * New records are keyed by eventId/saleAt, so repeated sales of one username
 * survive. Legacy records without saleAt keep the previous one-per-username
 * behavior. When a newly enriched event has the same username and price as a
 * legacy snapshot, it upgrades that snapshot in place instead of duplicating
 * the same historical sale during migration.
 */
function mergeNormalizedSoldHistory(
  input: readonly SoldRecord[],
  onConflict?: (
    error: SoldHistoryConflictError,
    record: SoldRecord,
    index: number,
  ) => void,
): SoldRecord[] {
  const records: SoldRecord[] = [];
  const byEvent = new Map<string, number>();
  const legacyByUsername = new Map<string, number>();
  const eventIndexesByUsername = new Map<string, Set<number>>();

  const rememberEventIndex = (username: string, index: number): void => {
    if (!eventIndexesByUsername.has(username)) {
      eventIndexesByUsername.set(username, new Set());
    }
    eventIndexesByUsername.get(username)!.add(index);
  };

  const append = (record: SoldRecord): void => {
    const key = eventKey(record);
    if (key) {
      const previousIndex = byEvent.get(key);
      if (previousIndex !== undefined) {
        records[previousIndex] = mergeSameEvent(records[previousIndex], record);
        return;
      }
      const legacyIndex = legacyByUsername.get(record.username);
      const legacy = legacyIndex === undefined ? undefined : records[legacyIndex];
      if (legacyIndex !== undefined && legacy && samePrice(legacy.priceTon, record.priceTon)) {
        records[legacyIndex] = mergeSameEvent(legacy, record);
        legacyByUsername.delete(record.username);
        byEvent.set(key, legacyIndex);
        rememberEventIndex(record.username, legacyIndex);
        return;
      }
      const index = records.push(record) - 1;
      byEvent.set(key, index);
      rememberEventIndex(record.username, index);
      return;
    }

    const enrichedIndexes = eventIndexesByUsername.get(record.username);
    const matchingEventIndex = enrichedIndexes
      ? [...enrichedIndexes].find((index) => {
          const candidate = records[index];
          return samePrice(candidate.priceTon, record.priceTon);
        })
      : undefined;
    if (matchingEventIndex !== undefined) {
      records[matchingEventIndex] = mergeSameEvent(records[matchingEventIndex], record);
      return;
    }

    const previousIndex = legacyByUsername.get(record.username);
    if (previousIndex !== undefined) {
      // Legacy snapshots have no stable occurrence id. Preserve their historic
      // one-row-per-username refresh behavior instead of treating a changed
      // observed price as an event-id collision.
      records[previousIndex] = mergeObservations(records[previousIndex], record);
      return;
    }
    legacyByUsername.set(record.username, records.push(record) - 1);
  };

  for (const [index, record] of input.entries()) {
    try {
      append(record);
    } catch (error) {
      if (error instanceof SoldHistoryConflictError && onConflict) {
        onConflict(error, record, index);
        continue;
      }
      throw error;
    }
  }

  return records;
}

export function mergeSoldHistory(existing: SoldRecord[], incoming: SoldRecord[]): SoldRecord[] {
  const normalized = [
    ...existing.map((record, index) =>
      requireSoldRecord(record, `Invalid existing sold record at index ${index}`),
    ),
    ...incoming.map((record, index) =>
      requireSoldRecord(record, `Invalid incoming sold record at index ${index}`),
    ),
  ];
  return mergeNormalizedSoldHistory(normalized);
}
