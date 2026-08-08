/**
 * Strict, read-only TON Center v3 client.
 *
 * This module intentionally stops at validated raw actions. In particular, an
 * `auction_bid`, a TON transfer, or a field inside `details` is not evidence by
 * itself that an asset was sold. Sale classification belongs in a separate
 * reconciliation layer that can require matching ownership and payment legs.
 *
 * API references:
 * https://docs.ton.org/api/v3/actions-and-traces/get-actions
 * https://toncenter.com/api/v3/doc.json
 */

export const TON_CENTER_V3_BASE_URL = "https://toncenter.com/api/v3";

const DEFAULT_LIMIT = 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const DEFAULT_PAGE_DELAY_MS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 10;
export const TON_CENTER_MAX_PAGES = 1_000;
export const TON_CENTER_MAX_COLLECTED_ROWS = 250_000;
const MAX_INT32 = 2_147_483_647;
const MAX_UINT32 = 4_294_967_295;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_QUERY_VALUES = 1_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 1_000_000;
const RAW_TON_ADDRESS_RE = /^-?\d+:[a-fA-F0-9]{64}$/;
const FRIENDLY_TON_ADDRESS_RE = /^[A-Za-z0-9+/_-]{48}$/;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export const TON_CENTER_V3_ACTION_TYPES = [
  "call_contract",
  "contract_deploy",
  "ton_transfer",
  "auction_bid",
  "change_dns",
  "dex_deposit_liquidity",
  "dex_withdraw_liquidity",
  "delete_dns",
  "renew_dns",
  "election_deposit",
  "election_recover",
  "jetton_burn",
  "jetton_swap",
  "jetton_transfer",
  "jetton_mint",
  "nft_mint",
  "tick_tock",
  "stake_deposit",
  "stake_withdrawal",
  "stake_withdrawal_request",
  "subscribe",
  "unsubscribe",
] as const;

export type TonCenterKnownActionType =
  (typeof TON_CENTER_V3_ACTION_TYPES)[number];

/**
 * Responses may contain newer action types when `supported_action_types=latest`
 * is used. Keep those typed as opaque strings instead of silently dropping
 * otherwise valid raw blockchain data.
 */
export type TonCenterActionType =
  | TonCenterKnownActionType
  | (string & Record<never, never>);

/** 0=pending, 1=confirmed, 2=finalized in the official v3 schema. */
export type TonCenterFinality = 0 | 1 | 2;

export type TonCenterJsonPrimitive = string | number | boolean | null;
export type TonCenterJsonValue =
  | TonCenterJsonPrimitive
  | TonCenterJsonObject
  | readonly TonCenterJsonValue[];
export interface TonCenterJsonObject {
  readonly [key: string]: TonCenterJsonValue;
}

/**
 * The snake_case shape mirrors TON Center's wire format. `details` remains
 * opaque JSON because the official schema deliberately leaves it untyped.
 */
export interface TonCenterRawAction {
  readonly action_id: string;
  readonly type: TonCenterActionType;
  readonly details: TonCenterJsonValue;
  readonly start_lt: string;
  readonly end_lt: string;
  readonly start_utime: number;
  readonly end_utime: number;
  readonly success: boolean;
  readonly trace_id: string;
  readonly trace_end_lt: string;
  readonly trace_end_utime: number;
  readonly trace_mc_seqno_end: number;
  readonly transactions: readonly string[];
  readonly accounts?: readonly string[];
  readonly transactions_full?: readonly TonCenterJsonObject[];
  readonly trace_external_hash?: string;
  readonly trace_external_hash_norm?: string;
  readonly finality?: TonCenterFinality;
}

export interface TonCenterActionsQuery {
  account?: string;
  txHashes?: readonly string[];
  msgHashes?: readonly string[];
  actionIds?: readonly string[];
  traceIds?: readonly string[];
  mcSeqno?: number;
  startUtime?: number;
  endUtime?: number;
  startLt?: string | bigint;
  endLt?: string | bigint;
  actionTypes?: readonly TonCenterKnownActionType[];
  excludeActionTypes?: readonly TonCenterKnownActionType[];
  /**
   * Action parser versions understood by the caller. Defaults to `latest` so
   * ingestion does not silently omit newly supported raw action types.
   */
  supportedActionTypes?: readonly string[];
  includeAccounts?: boolean;
  includeTransactions?: boolean;
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
}

export interface TonCenterClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface TonCenterCollectOptions extends TonCenterClientOptions {
  /** Explicit guard against an accidental unbounded public-API crawl. */
  maxPages: number;
  /** Defaults to one second, compatible with anonymous public access. */
  pageDelayMs?: number;
}

export type TonCenterDiagnosticCode =
  | "retry_scheduled"
  | "action_quarantined"
  | "duplicate_action_id"
  | "action_revision_merged"
  | "conflicting_action_id"
  | "nft_sale_contract_quarantined"
  | "nft_sale_contract_missing"
  | "max_pages_reached";

export interface TonCenterDiagnostic {
  code: TonCenterDiagnosticCode;
  severity: "warning" | "error";
  message: string;
  page?: number;
  offset?: number;
  rowIndex?: number;
  actionId?: string;
  attempt?: number;
  status?: number;
  retryDelayMs?: number;
}

export interface TonCenterQuarantinedAction {
  raw: unknown;
  reasons: readonly string[];
  offset: number;
  rowIndex?: number;
  page?: number;
}

export interface TonCenterActionsPage {
  actions: TonCenterRawAction[];
  quarantined: TonCenterQuarantinedAction[];
  diagnostics: TonCenterDiagnostic[];
  addressBook?: TonCenterJsonObject;
  metadata?: TonCenterJsonObject;
  requestUrl: string;
  fetchedAt: string;
  attempts: number;
  rawCount: number;
  offset: number;
  limit: number;
  complete: boolean;
  nextOffset: number | null;
}

export interface TonCenterActionsCollection {
  actions: TonCenterRawAction[];
  quarantined: TonCenterQuarantinedAction[];
  diagnostics: TonCenterDiagnostic[];
  pagesFetched: number;
  /** Effective upper bound used to keep descending offset pagination stable. */
  snapshotEndUtime?: number;
  complete: boolean;
  nextOffset: number | null;
}

/**
 * A snapshot of a GetGems sale/auction contract returned by `/nft/sales`.
 * Despite the upstream schema name `NFTSale`, this is contract state, not a
 * completed sale. `created_at` is contract creation time and `details` is
 * intentionally opaque; neither field is promoted to a market sale event.
 */
export interface TonCenterNftSaleContractSnapshot {
  readonly evidenceKind: "nft-sale-contract-state";
  readonly provesCompletedSale: false;
  readonly address: string;
  readonly code_hash?: string;
  readonly created_at: number;
  readonly data_hash?: string;
  readonly details: TonCenterJsonObject;
  readonly last_transaction_lt: string;
  readonly marketplace_address?: string;
  readonly nft_address: string;
  readonly nft_item?: TonCenterJsonObject;
  readonly nft_owner_address?: string;
  readonly type: string;
}

export interface TonCenterNftSalesQuery {
  /** Sale or auction contract addresses. The official endpoint caps this at 1000. */
  addresses: readonly string[];
}

export interface TonCenterQuarantinedNftSaleContract {
  raw: unknown;
  reasons: readonly string[];
  rowIndex: number;
}

export interface TonCenterNftSaleContractsResponse {
  contracts: TonCenterNftSaleContractSnapshot[];
  quarantined: TonCenterQuarantinedNftSaleContract[];
  /** Requested contracts for which no strictly valid matching row was returned. */
  missingAddresses: string[];
  diagnostics: TonCenterDiagnostic[];
  addressBook?: TonCenterJsonObject;
  metadata?: TonCenterJsonObject;
  requestUrl: string;
  fetchedAt: string;
  attempts: number;
  rawCount: number;
}

interface CollectedActionState {
  action: TonCenterRawAction;
  canonical: string;
  occurrence: string;
  index: number;
}

export class TonCenterClientError extends Error {
  readonly diagnostics: readonly TonCenterDiagnostic[];

  constructor(
    message: string,
    diagnostics: readonly TonCenterDiagnostic[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TonCenterClientError";
    this.diagnostics = diagnostics;
  }
}

export class TonCenterInputError extends TonCenterClientError {
  constructor(message: string) {
    super(message);
    this.name = "TonCenterInputError";
  }
}

export class TonCenterHttpError extends TonCenterClientError {
  constructor(
    readonly status: number,
    readonly responseSummary: string | undefined,
    readonly retryAfterMs: number | undefined,
    diagnostics: readonly TonCenterDiagnostic[],
  ) {
    const suffix = responseSummary ? `: ${responseSummary}` : "";
    super(`TON Center returned HTTP ${status}${suffix}`, diagnostics);
    this.name = "TonCenterHttpError";
  }
}

export class TonCenterValidationError extends TonCenterClientError {
  constructor(
    message: string,
    diagnostics: readonly TonCenterDiagnostic[] = [],
    options?: ErrorOptions,
  ) {
    super(message, diagnostics, options);
    this.name = "TonCenterValidationError";
  }
}

export class TonCenterTransportError extends TonCenterClientError {
  constructor(
    message: string,
    diagnostics: readonly TonCenterDiagnostic[],
    options?: ErrorOptions,
  ) {
    super(message, diagnostics, options);
    this.name = "TonCenterTransportError";
  }
}

interface NormalizedClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  maxResponseBytes: number;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
}

interface ValidatedEnvelope {
  actions: unknown[];
  addressBook?: TonCenterJsonObject;
  metadata?: TonCenterJsonObject;
}

interface ValidatedNftSalesEnvelope {
  nftSales: unknown[];
  addressBook?: TonCenterJsonObject;
  metadata?: TonCenterJsonObject;
}

interface RequestResult {
  body: string;
  attempts: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function actionOccurrence(action: TonCenterRawAction): string {
  return canonicalJson({
    action_id: action.action_id,
    type: action.type,
    start_lt: action.start_lt,
    end_lt: action.end_lt,
    start_utime: action.start_utime,
    end_utime: action.end_utime,
    success: action.success,
    trace_id: action.trace_id,
    trace_end_lt: action.trace_end_lt,
    trace_end_utime: action.trace_end_utime,
    trace_mc_seqno_end: action.trace_mc_seqno_end,
    transactions: [...action.transactions].sort(),
  });
}

function optionalIdentityCompatible(
  previous: string | undefined,
  next: string | undefined,
): boolean {
  return previous === undefined || next === undefined || previous === next;
}

/**
 * Revisions may add object fields or append array entries, but an already
 * observed scalar cannot change value. Deep-merging such a contradiction
 * would manufacture a payload that TON Center never returned.
 */
function collectJsonRevisionConflicts(
  previous: TonCenterJsonValue,
  next: TonCenterJsonValue,
  path: string,
  out: string[],
): void {
  if (canonicalJson(previous) === canonicalJson(next)) return;
  if (isObject(previous) && isObject(next)) {
    for (const key of Object.keys(previous)) {
      if (next[key] === undefined) continue;
      collectJsonRevisionConflicts(
        previous[key] as TonCenterJsonValue,
        next[key] as TonCenterJsonValue,
        `${path}.${key}`,
        out,
      );
    }
    return;
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    const commonLength = Math.min(previous.length, next.length);
    for (let index = 0; index < commonLength; index++) {
      collectJsonRevisionConflicts(
        previous[index],
        next[index],
        `${path}[${index}]`,
        out,
      );
    }
    return;
  }
  out.push(`${path} changed from ${canonicalJson(previous)} to ${canonicalJson(next)}`);
}

function actionRevisionConflicts(
  previous: TonCenterRawAction,
  next: TonCenterRawAction,
): string[] {
  const conflicts: string[] = [];
  collectJsonRevisionConflicts(previous.details, next.details, "details", conflicts);
  if (
    previous.transactions_full !== undefined &&
    next.transactions_full !== undefined
  ) {
    collectJsonRevisionConflicts(
      previous.transactions_full,
      next.transactions_full,
      "transactions_full",
      conflicts,
    );
  }
  return conflicts;
}

function mergeJsonRevision(
  previous: TonCenterJsonValue,
  next: TonCenterJsonValue,
  preferNextConflicts: boolean,
): TonCenterJsonValue {
  if (
    isObject(previous) &&
    !Array.isArray(previous) &&
    isObject(next) &&
    !Array.isArray(next)
  ) {
    const result: Record<string, TonCenterJsonValue> = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const previousValue = previous[key] as TonCenterJsonValue | undefined;
      const nextValue = next[key] as TonCenterJsonValue | undefined;
      if (nextValue === undefined) {
        if (previousValue !== undefined) result[key] = previousValue;
      } else if (previousValue === undefined) {
        result[key] = nextValue;
      } else {
        result[key] = mergeJsonRevision(
          previousValue,
          nextValue,
          preferNextConflicts,
        );
      }
    }
    return result;
  }
  if (canonicalJson(previous) === canonicalJson(next)) return previous;
  return preferNextConflicts ? next : previous;
}

function mergeActionRevision(
  previous: TonCenterRawAction,
  next: TonCenterRawAction,
): TonCenterRawAction {
  const previousFinality = previous.finality ?? 0;
  const nextFinality = next.finality ?? 0;
  const preferNextConflicts = nextFinality >= previousFinality;
  const accounts = [...new Set([...(previous.accounts ?? []), ...(next.accounts ?? [])])];
  const preferredBase = preferNextConflicts
    ? { ...previous, ...next }
    : { ...next, ...previous };
  return {
    ...preferredBase,
    details: mergeJsonRevision(previous.details, next.details, preferNextConflicts),
    ...(accounts.length > 0 ? { accounts } : {}),
    ...(preferNextConflicts && next.transactions_full !== undefined
      ? { transactions_full: next.transactions_full }
      : previous.transactions_full !== undefined
        ? { transactions_full: previous.transactions_full }
        : next.transactions_full !== undefined
          ? { transactions_full: next.transactions_full }
          : {}),
    ...(preferNextConflicts && next.trace_external_hash !== undefined
      ? { trace_external_hash: next.trace_external_hash }
      : previous.trace_external_hash !== undefined
        ? { trace_external_hash: previous.trace_external_hash }
        : next.trace_external_hash !== undefined
          ? { trace_external_hash: next.trace_external_hash }
        : {}),
    ...(preferNextConflicts && next.trace_external_hash_norm !== undefined
      ? { trace_external_hash_norm: next.trace_external_hash_norm }
      : previous.trace_external_hash_norm !== undefined
        ? { trace_external_hash_norm: previous.trace_external_hash_norm }
        : next.trace_external_hash_norm !== undefined
          ? { trace_external_hash_norm: next.trace_external_hash_norm }
        : {}),
    ...(previous.finality !== undefined || next.finality !== undefined
      ? { finality: Math.max(previous.finality ?? 0, next.finality ?? 0) as TonCenterFinality }
      : {}),
  };
}

function isNonEmptyWireString(value: unknown, maxLength = 2_048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isTonAddress(value: unknown): value is string {
  return (
    isNonEmptyWireString(value, 128) &&
    (RAW_TON_ADDRESS_RE.test(value) || FRIENDLY_TON_ADDRESS_RE.test(value))
  );
}

function crc16Ccitt(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Canonical account identity for matching raw and valid friendly forms. */
function tonAddressIdentity(address: string): string {
  const raw = address.match(/^(-?\d+):([a-fA-F0-9]{64})$/);
  if (raw) return `${BigInt(raw[1]).toString()}:${raw[2].toLowerCase()}`;
  if (FRIENDLY_TON_ADDRESS_RE.test(address)) {
    try {
      const decoded = Buffer.from(address.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (decoded.length === 36) {
        const checksum = (decoded[34] << 8) | decoded[35];
        const tag = decoded[0] & 0x7f;
        if (
          (tag === 0x11 || tag === 0x51) &&
          crc16Ccitt(decoded.subarray(0, 34)) === checksum
        ) {
          const workchain = decoded[1] > 127 ? decoded[1] - 256 : decoded[1];
          return `${workchain}:${decoded.subarray(2, 34).toString("hex")}`;
        }
      }
    } catch {
      // Fall through to exact wire identity for legacy syntactic addresses.
    }
  }
  return `wire:${address}`;
}

function isUnixSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_UINT32
  );
}

function isUint32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_INT32
  );
}

function isLogicalTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_INT64;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_QUERY_VALUES &&
    value.every((item) => isNonEmptyWireString(item))
  );
}

function isJsonValue(value: unknown): value is TonCenterJsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes++;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;

    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isObject(current.value)) return false;
    for (const item of Object.values(current.value)) {
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

function validateRawAction(value: unknown): string[] {
  if (!isObject(value)) return ["action must be a JSON object"];
  const reasons: string[] = [];

  if (!isNonEmptyWireString(value.action_id)) {
    reasons.push("action_id must be a non-empty bounded string");
  }
  if (
    !isNonEmptyWireString(value.type, 128) ||
    !/^[a-z][a-z0-9_]*$/.test(value.type)
  ) {
    reasons.push("type must be a lower-case snake_case action name");
  }
  if (!Object.hasOwn(value, "details") || !isJsonValue(value.details)) {
    reasons.push("details must be present and contain bounded valid JSON");
  }

  for (const field of ["start_lt", "end_lt", "trace_end_lt"] as const) {
    if (!isLogicalTime(value[field])) {
      reasons.push(`${field} must be a canonical non-negative int64 string`);
    }
  }
  for (const field of [
    "start_utime",
    "end_utime",
    "trace_end_utime",
    "trace_mc_seqno_end",
  ] as const) {
    if (!isUint32(value[field])) {
      reasons.push(`${field} must be a non-negative int32`);
    }
  }

  if (typeof value.success !== "boolean") {
    reasons.push("success must be boolean");
  }
  if (!isNonEmptyWireString(value.trace_id)) {
    reasons.push("trace_id must be a non-empty bounded string");
  }
  if (!isStringArray(value.transactions)) {
    reasons.push("transactions must be a bounded array of non-empty strings");
  }
  if (value.accounts !== undefined && !isStringArray(value.accounts)) {
    reasons.push("accounts must be a bounded array of non-empty strings when present");
  }
  if (
    value.trace_external_hash !== undefined &&
    !isNonEmptyWireString(value.trace_external_hash)
  ) {
    reasons.push("trace_external_hash must be a non-empty bounded string when present");
  }
  if (
    value.trace_external_hash_norm !== undefined &&
    !isNonEmptyWireString(value.trace_external_hash_norm)
  ) {
    reasons.push(
      "trace_external_hash_norm must be a non-empty bounded string when present",
    );
  }
  if (
    value.finality !== undefined &&
    value.finality !== 0 &&
    value.finality !== 1 &&
    value.finality !== 2
  ) {
    reasons.push("finality must be 0, 1, or 2 when present");
  }
  if (
    value.transactions_full !== undefined &&
    (!Array.isArray(value.transactions_full) ||
      value.transactions_full.length > MAX_QUERY_VALUES ||
      !value.transactions_full.every(
        (transaction) => isObject(transaction) && isJsonValue(transaction),
      ))
  ) {
    reasons.push("transactions_full must be a bounded array of JSON objects when present");
  }

  if (
    isLogicalTime(value.start_lt) &&
    isLogicalTime(value.end_lt) &&
    BigInt(value.start_lt) > BigInt(value.end_lt)
  ) {
    reasons.push("start_lt must not exceed end_lt");
  }
  if (
    isLogicalTime(value.end_lt) &&
    isLogicalTime(value.trace_end_lt) &&
    BigInt(value.end_lt) > BigInt(value.trace_end_lt)
  ) {
    reasons.push("end_lt must not exceed trace_end_lt");
  }
  if (
    isUint32(value.start_utime) &&
    isUint32(value.end_utime) &&
    value.start_utime > value.end_utime
  ) {
    reasons.push("start_utime must not exceed end_utime");
  }
  if (
    isUint32(value.end_utime) &&
    isUint32(value.trace_end_utime) &&
    value.end_utime > value.trace_end_utime
  ) {
    reasons.push("end_utime must not exceed trace_end_utime");
  }
  if (!isJsonValue(value)) {
    reasons.push("action contains non-JSON, excessively deep, or excessively large data");
  }

  return reasons;
}

function validateNftSaleContractSnapshot(value: unknown): string[] {
  if (!isObject(value)) return ["NFT sale contract must be a JSON object"];
  const reasons: string[] = [];

  if (!isTonAddress(value.address)) {
    reasons.push("address must be a raw or friendly TON address");
  }
  if (!isUnixSeconds(value.created_at)) {
    reasons.push("created_at must be a non-negative uint32 Unix timestamp");
  }
  if (!isLogicalTime(value.last_transaction_lt)) {
    reasons.push("last_transaction_lt must be a canonical non-negative int64 string");
  }
  if (!isTonAddress(value.nft_address)) {
    reasons.push("nft_address must be a raw or friendly TON address");
  }
  if (
    !isNonEmptyWireString(value.type, 128) ||
    !/^[a-z][a-z0-9_-]*$/.test(value.type)
  ) {
    reasons.push("type must be a bounded lower-case contract type");
  }
  if (!isObject(value.details) || !isJsonValue(value.details)) {
    reasons.push("details must be a bounded JSON object");
  }

  for (const field of [
    "marketplace_address",
    "nft_owner_address",
  ] as const) {
    if (value[field] !== undefined && !isTonAddress(value[field])) {
      reasons.push(`${field} must be a raw or friendly TON address when present`);
    }
  }
  for (const field of ["code_hash", "data_hash"] as const) {
    if (value[field] !== undefined && !isNonEmptyWireString(value[field], 256)) {
      reasons.push(`${field} must be a non-empty bounded string when present`);
    }
  }
  if (
    value.nft_item !== undefined &&
    (!isObject(value.nft_item) || !isJsonValue(value.nft_item))
  ) {
    reasons.push("nft_item must be a bounded JSON object when present");
  }
  if (!isJsonValue(value)) {
    reasons.push(
      "NFT sale contract contains non-JSON, excessively deep, or excessively large data",
    );
  }

  return reasons;
}

function asNftSaleContractSnapshot(
  value: Record<string, unknown>,
): TonCenterNftSaleContractSnapshot {
  return {
    evidenceKind: "nft-sale-contract-state",
    provesCompletedSale: false,
    address: value.address as string,
    ...(value.code_hash === undefined ? {} : { code_hash: value.code_hash as string }),
    created_at: value.created_at as number,
    ...(value.data_hash === undefined ? {} : { data_hash: value.data_hash as string }),
    details: value.details as TonCenterJsonObject,
    last_transaction_lt: value.last_transaction_lt as string,
    ...(value.marketplace_address === undefined
      ? {}
      : { marketplace_address: value.marketplace_address as string }),
    nft_address: value.nft_address as string,
    ...(value.nft_item === undefined
      ? {}
      : { nft_item: value.nft_item as TonCenterJsonObject }),
    ...(value.nft_owner_address === undefined
      ? {}
      : { nft_owner_address: value.nft_owner_address as string }),
    type: value.type as string,
  };
}

function requireInteger(
  name: string,
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new TonCenterInputError(
      `${name} must be a safe integer in [${minimum}, ${maximum}]`,
    );
  }
  return resolved;
}

function requireFiniteNumber(
  name: string,
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new TonCenterInputError(
      `${name} must be a finite number in [${minimum}, ${maximum}]`,
    );
  }
  return resolved;
}

function normalizeApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TonCenterInputError(
      "apiKey must be a non-empty bounded string without control characters",
    );
  }
  return value;
}

function normalizeBaseUrl(value: string | undefined): string {
  const candidate = value ?? TON_CENTER_V3_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TonCenterInputError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TonCenterInputError(
      "baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeClientOptions(
  options: TonCenterClientOptions,
): NormalizedClientOptions {
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") {
    throw new TonCenterInputError("fetchImpl must be a function");
  }
  if (options.sleepImpl !== undefined && typeof options.sleepImpl !== "function") {
    throw new TonCenterInputError("sleepImpl must be a function");
  }
  return {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    apiKey: normalizeApiKey(options.apiKey),
    timeoutMs: requireInteger(
      "timeoutMs",
      options.timeoutMs,
      1,
      MAX_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    maxRetries: requireInteger(
      "maxRetries",
      options.maxRetries,
      0,
      MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
    ),
    retryBaseDelayMs: requireFiniteNumber(
      "retryBaseDelayMs",
      options.retryBaseDelayMs,
      0,
      MAX_RETRY_DELAY_MS,
      DEFAULT_RETRY_BASE_DELAY_MS,
    ),
    maxResponseBytes: requireInteger(
      "maxResponseBytes",
      options.maxResponseBytes,
      1_024,
      64 * 1024 * 1024,
      DEFAULT_MAX_RESPONSE_BYTES,
    ),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    sleepImpl: options.sleepImpl ?? sleep,
  };
}

function normalizeLogicalTime(
  name: string,
  value: string | bigint | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === "bigint" ? value.toString() : value;
  if (!isLogicalTime(normalized)) {
    throw new TonCenterInputError(
      `${name} must be a canonical non-negative int64 string or bigint`,
    );
  }
  return normalized;
}

function normalizeQueryString(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyWireString(value)) {
    throw new TonCenterInputError(
      `${name} must be a non-empty bounded string without control characters`,
    );
  }
  return value;
}

function normalizeStringList(
  name: string,
  value: readonly string[] | undefined,
  pattern?: RegExp,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUERY_VALUES) {
    throw new TonCenterInputError(
      `${name} must be a non-empty array with at most ${MAX_QUERY_VALUES} values`,
    );
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isNonEmptyWireString(item) || (pattern && !pattern.test(item))) {
      throw new TonCenterInputError(`${name} contains an invalid value`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }
  return normalized;
}

function normalizeTonAddressList(
  name: string,
  value: readonly string[] | undefined,
): string[] {
  const normalized = normalizeStringList(name, value);
  if (normalized === undefined) {
    throw new TonCenterInputError(`${name} is required`);
  }
  if (normalized.some((address) => !isTonAddress(address))) {
    throw new TonCenterInputError(
      `${name} must contain only raw or friendly TON addresses`,
    );
  }
  return normalized;
}

function normalizeKnownActionTypes(
  name: string,
  values: readonly TonCenterKnownActionType[] | undefined,
): TonCenterKnownActionType[] | undefined {
  const normalized = normalizeStringList(name, values);
  if (!normalized) return undefined;
  const known = new Set<string>(TON_CENTER_V3_ACTION_TYPES);
  if (normalized.some((value) => !known.has(value))) {
    throw new TonCenterInputError(`${name} contains an unsupported action type`);
  }
  return normalized as TonCenterKnownActionType[];
}

interface NormalizedQuery {
  account?: string;
  txHashes?: string[];
  msgHashes?: string[];
  actionIds?: string[];
  traceIds?: string[];
  mcSeqno?: number;
  startUtime?: number;
  endUtime?: number;
  startLt?: string;
  endLt?: string;
  actionTypes?: TonCenterKnownActionType[];
  excludeActionTypes?: TonCenterKnownActionType[];
  supportedActionTypes: string[];
  includeAccounts?: boolean;
  includeTransactions?: boolean;
  limit: number;
  offset: number;
  sort: "asc" | "desc";
}

function normalizeQuery(query: TonCenterActionsQuery): NormalizedQuery {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new TonCenterInputError("query must be an object");
  }
  const startLt = normalizeLogicalTime("startLt", query.startLt);
  const endLt = normalizeLogicalTime("endLt", query.endLt);
  if (startLt !== undefined && endLt !== undefined && BigInt(startLt) > BigInt(endLt)) {
    throw new TonCenterInputError("startLt must not exceed endLt");
  }

  const startUtime =
    query.startUtime === undefined
      ? undefined
      : requireInteger("startUtime", query.startUtime, 0, MAX_INT32, 0);
  const endUtime =
    query.endUtime === undefined
      ? undefined
      : requireInteger("endUtime", query.endUtime, 0, MAX_INT32, 0);
  if (
    startUtime !== undefined &&
    endUtime !== undefined &&
    startUtime > endUtime
  ) {
    throw new TonCenterInputError("startUtime must not exceed endUtime");
  }

  const actionTypes = normalizeKnownActionTypes("actionTypes", query.actionTypes);
  const excludeActionTypes = normalizeKnownActionTypes(
    "excludeActionTypes",
    query.excludeActionTypes,
  );
  if (
    actionTypes &&
    excludeActionTypes &&
    actionTypes.some((type) => excludeActionTypes.includes(type))
  ) {
    throw new TonCenterInputError(
      "actionTypes and excludeActionTypes must not contain the same type",
    );
  }
  if (
    query.includeAccounts !== undefined &&
    typeof query.includeAccounts !== "boolean"
  ) {
    throw new TonCenterInputError("includeAccounts must be boolean");
  }
  if (
    query.includeTransactions !== undefined &&
    typeof query.includeTransactions !== "boolean"
  ) {
    throw new TonCenterInputError("includeTransactions must be boolean");
  }
  if (query.sort !== undefined && query.sort !== "asc" && query.sort !== "desc") {
    throw new TonCenterInputError('sort must be either "asc" or "desc"');
  }

  return {
    account: normalizeQueryString("account", query.account),
    txHashes: normalizeStringList("txHashes", query.txHashes),
    msgHashes: normalizeStringList("msgHashes", query.msgHashes),
    actionIds: normalizeStringList("actionIds", query.actionIds),
    traceIds: normalizeStringList("traceIds", query.traceIds),
    mcSeqno:
      query.mcSeqno === undefined
        ? undefined
        : requireInteger("mcSeqno", query.mcSeqno, 0, MAX_INT32, 0),
    startUtime,
    endUtime,
    startLt,
    endLt,
    actionTypes,
    excludeActionTypes,
    supportedActionTypes:
      normalizeStringList(
        "supportedActionTypes",
        query.supportedActionTypes,
        /^(?:latest|[a-z][a-z0-9_]*)$/,
      ) ?? ["latest"],
    includeAccounts: query.includeAccounts,
    includeTransactions: query.includeTransactions,
    limit: requireInteger("limit", query.limit, 1, 1_000, DEFAULT_LIMIT),
    offset: requireInteger("offset", query.offset, 0, MAX_INT32, 0),
    sort: query.sort ?? "desc",
  };
}

function appendMany(url: URL, name: string, values: readonly string[] | undefined): void {
  for (const value of values ?? []) url.searchParams.append(name, value);
}

function actionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/actions`;
  return url;
}

function buildUrlFromNormalized(baseUrl: string, query: NormalizedQuery): string {
  const url = actionsUrl(baseUrl);
  if (query.account !== undefined) url.searchParams.set("account", query.account);
  appendMany(url, "tx_hash", query.txHashes);
  appendMany(url, "msg_hash", query.msgHashes);
  appendMany(url, "action_id", query.actionIds);
  appendMany(url, "trace_id", query.traceIds);
  if (query.mcSeqno !== undefined) {
    url.searchParams.set("mc_seqno", String(query.mcSeqno));
  }
  if (query.startUtime !== undefined) {
    url.searchParams.set("start_utime", String(query.startUtime));
  }
  if (query.endUtime !== undefined) {
    url.searchParams.set("end_utime", String(query.endUtime));
  }
  if (query.startLt !== undefined) url.searchParams.set("start_lt", query.startLt);
  if (query.endLt !== undefined) url.searchParams.set("end_lt", query.endLt);
  appendMany(url, "action_type", query.actionTypes);
  appendMany(url, "exclude_action_type", query.excludeActionTypes);
  appendMany(url, "supported_action_types", query.supportedActionTypes);
  if (query.includeAccounts !== undefined) {
    url.searchParams.set("include_accounts", String(query.includeAccounts));
  }
  if (query.includeTransactions !== undefined) {
    url.searchParams.set("include_transactions", String(query.includeTransactions));
  }
  url.searchParams.set("limit", String(query.limit));
  url.searchParams.set("offset", String(query.offset));
  url.searchParams.set("sort", query.sort);
  return url.toString();
}

export function buildTonCenterActionsUrl(
  query: TonCenterActionsQuery = {},
  baseUrl = TON_CENTER_V3_BASE_URL,
): string {
  return buildUrlFromNormalized(normalizeBaseUrl(baseUrl), normalizeQuery(query));
}

function nftSalesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/nft/sales`;
  return url;
}

export function buildTonCenterNftSalesUrl(
  query: TonCenterNftSalesQuery,
  baseUrl = TON_CENTER_V3_BASE_URL,
): string {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new TonCenterInputError("query must be an object");
  }
  const addresses = normalizeTonAddressList("addresses", query.addresses);
  const url = nftSalesUrl(normalizeBaseUrl(baseUrl));
  appendMany(url, "address", addresses);
  return url.toString();
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
}

function responseSummary(body: string): string | undefined {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function readBoundedResponseBody(
  response: Response,
  maxResponseBytes: number,
  diagnostics: TonCenterDiagnostic[],
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxResponseBytes) {
      throw new TonCenterValidationError(
        `TON Center response exceeds maxResponseBytes=${maxResponseBytes}`,
        diagnostics,
      );
    }
  }

  if (response.body === null) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) {
      throw new TonCenterValidationError(
        `TON Center response exceeds maxResponseBytes=${maxResponseBytes}`,
        diagnostics,
      );
    }
    return body;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxResponseBytes) {
        await reader.cancel("response exceeds configured byte limit").catch(() => {});
        throw new TonCenterValidationError(
          `TON Center response exceeds maxResponseBytes=${maxResponseBytes}`,
          diagnostics,
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    if (error instanceof TonCenterClientError) throw error;
    throw new TonCenterValidationError(
      "TON Center response body is not valid UTF-8",
      diagnostics,
      { cause: error },
    );
  } finally {
    reader.releaseLock();
  }
}

async function requestActions(
  requestUrl: string,
  options: NormalizedClientOptions,
  diagnostics: TonCenterDiagnostic[],
  offset: number,
): Promise<RequestResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "tg-username-finder/1.0",
      };
      if (options.apiKey) headers["X-API-Key"] = options.apiKey;

      const response = await options.fetchImpl(requestUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const body = await readBoundedResponseBody(
        response,
        options.maxResponseBytes,
        diagnostics,
      );
      if (!response.ok) {
        throw new TonCenterHttpError(
          response.status,
          responseSummary(body),
          parseRetryAfter(response.headers.get("retry-after")),
          diagnostics,
        );
      }
      return { body, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof TonCenterHttpError
          ? RETRYABLE_HTTP_STATUSES.has(error.status)
          : !(error instanceof TonCenterValidationError);
      if (!retryable || attempt >= options.maxRetries) break;

      const retryAfterMs =
        error instanceof TonCenterHttpError ? error.retryAfterMs : undefined;
      const retryDelayMs = Math.min(
        MAX_RETRY_DELAY_MS,
        Math.max(
          retryAfterMs ?? 0,
          options.retryBaseDelayMs * 2 ** attempt,
        ),
      );
      diagnostics.push({
        code: "retry_scheduled",
        severity: "warning",
        message: `TON Center request failed; retry ${attempt + 2} scheduled`,
        offset,
        attempt: attempt + 1,
        ...(error instanceof TonCenterHttpError ? { status: error.status } : {}),
        retryDelayMs,
      });
      await options.sleepImpl(retryDelayMs);
    }
  }

  if (lastError instanceof TonCenterClientError) throw lastError;
  throw new TonCenterTransportError(
    `TON Center request failed: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    diagnostics,
    { cause: lastError },
  );
}

function parseEnvelope(
  body: string,
  diagnostics: TonCenterDiagnostic[],
): ValidatedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new TonCenterValidationError(
      "TON Center returned malformed JSON",
      diagnostics,
      { cause: error },
    );
  }
  if (!isObject(parsed) || !Array.isArray(parsed.actions)) {
    throw new TonCenterValidationError(
      "TON Center response must be an object with an actions array",
      diagnostics,
    );
  }

  const addressBook = parsed.address_book;
  if (
    addressBook !== undefined &&
    (!isObject(addressBook) || !isJsonValue(addressBook))
  ) {
    throw new TonCenterValidationError(
      "TON Center address_book must be a bounded JSON object when present",
      diagnostics,
    );
  }
  const metadata = parsed.metadata;
  if (metadata !== undefined && (!isObject(metadata) || !isJsonValue(metadata))) {
    throw new TonCenterValidationError(
      "TON Center metadata must be a bounded JSON object when present",
      diagnostics,
    );
  }
  return {
    actions: parsed.actions,
    ...(addressBook !== undefined
      ? { addressBook: addressBook as TonCenterJsonObject }
      : {}),
    ...(metadata !== undefined ? { metadata: metadata as TonCenterJsonObject } : {}),
  };
}

function parseNftSalesEnvelope(
  body: string,
  diagnostics: TonCenterDiagnostic[],
): ValidatedNftSalesEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new TonCenterValidationError(
      "TON Center returned malformed JSON",
      diagnostics,
      { cause: error },
    );
  }
  if (!isObject(parsed) || !Array.isArray(parsed.nft_sales)) {
    throw new TonCenterValidationError(
      "TON Center response must be an object with an nft_sales array",
      diagnostics,
    );
  }

  const addressBook = parsed.address_book;
  if (
    addressBook !== undefined &&
    (!isObject(addressBook) || !isJsonValue(addressBook))
  ) {
    throw new TonCenterValidationError(
      "TON Center address_book must be a bounded JSON object when present",
      diagnostics,
    );
  }
  const metadata = parsed.metadata;
  if (metadata !== undefined && (!isObject(metadata) || !isJsonValue(metadata))) {
    throw new TonCenterValidationError(
      "TON Center metadata must be a bounded JSON object when present",
      diagnostics,
    );
  }
  return {
    nftSales: parsed.nft_sales,
    ...(addressBook === undefined
      ? {}
      : { addressBook: addressBook as TonCenterJsonObject }),
    ...(metadata === undefined
      ? {}
      : { metadata: metadata as TonCenterJsonObject }),
  };
}

/**
 * Fetch and validate exactly one offset page. Malformed rows are quarantined;
 * a malformed response envelope is rejected because pagination cannot proceed
 * safely without a trustworthy `actions` array.
 */
export async function fetchTonCenterActionsPage(
  query: TonCenterActionsQuery = {},
  options: TonCenterClientOptions = {},
): Promise<TonCenterActionsPage> {
  const normalizedOptions = normalizeClientOptions(options);
  const normalizedQuery = normalizeQuery(query);
  const requestUrl = buildUrlFromNormalized(
    normalizedOptions.baseUrl,
    normalizedQuery,
  );
  const diagnostics: TonCenterDiagnostic[] = [];
  const request = await requestActions(
    requestUrl,
    normalizedOptions,
    diagnostics,
    normalizedQuery.offset,
  );
  const envelope = parseEnvelope(request.body, diagnostics);
  if (envelope.actions.length > normalizedQuery.limit) {
    throw new TonCenterValidationError(
      `TON Center returned ${envelope.actions.length} actions for limit=${normalizedQuery.limit}`,
      diagnostics,
    );
  }

  const actions: TonCenterRawAction[] = [];
  const quarantined: TonCenterQuarantinedAction[] = [];
  for (const [rowIndex, raw] of envelope.actions.entries()) {
    const reasons = validateRawAction(raw);
    if (reasons.length === 0) {
      actions.push(raw as unknown as TonCenterRawAction);
      continue;
    }
    quarantined.push({
      raw,
      reasons,
      offset: normalizedQuery.offset,
      rowIndex,
    });
    diagnostics.push({
      code: "action_quarantined",
      severity: "error",
      message: `TON Center action row ${rowIndex} failed strict validation`,
      offset: normalizedQuery.offset,
      rowIndex,
      ...(isObject(raw) && isNonEmptyWireString(raw.action_id)
        ? { actionId: raw.action_id }
        : {}),
    });
  }

  const complete = envelope.actions.length < normalizedQuery.limit;
  const nextOffset = complete
    ? null
    : normalizedQuery.offset + normalizedQuery.limit;
  if (nextOffset !== null && nextOffset > MAX_INT32) {
    throw new TonCenterValidationError(
      "TON Center pagination offset exceeds int32 range",
      diagnostics,
    );
  }

  return {
    actions,
    quarantined,
    diagnostics,
    ...(envelope.addressBook ? { addressBook: envelope.addressBook } : {}),
    ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    requestUrl,
    fetchedAt: new Date().toISOString(),
    attempts: request.attempts,
    rawCount: envelope.actions.length,
    offset: normalizedQuery.offset,
    limit: normalizedQuery.limit,
    complete,
    nextOffset,
  };
}

/**
 * Fetches strictly validated GetGems sale/auction contract snapshots.
 *
 * This endpoint is useful for reconciling an NFT with its marketplace
 * contract, but it does not expose a completed-sale transaction/time. The
 * returned objects therefore carry `provesCompletedSale: false` and this
 * module deliberately provides no conversion to `MarketEvent`/`SoldRecord`.
 */
export async function fetchTonCenterNftSaleContracts(
  query: TonCenterNftSalesQuery,
  options: TonCenterClientOptions = {},
): Promise<TonCenterNftSaleContractsResponse> {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new TonCenterInputError("query must be an object");
  }
  const addresses = normalizeTonAddressList("addresses", query.addresses);
  const normalizedOptions = normalizeClientOptions(options);
  const requestUrl = buildTonCenterNftSalesUrl(
    { addresses },
    normalizedOptions.baseUrl,
  );
  const diagnostics: TonCenterDiagnostic[] = [];
  const request = await requestActions(
    requestUrl,
    normalizedOptions,
    diagnostics,
    0,
  );
  const envelope = parseNftSalesEnvelope(request.body, diagnostics);
  if (envelope.nftSales.length > MAX_QUERY_VALUES) {
    throw new TonCenterValidationError(
      `TON Center returned more than ${MAX_QUERY_VALUES} NFT sale contracts`,
      diagnostics,
    );
  }

  const requestedByIdentity = new Map(
    addresses.map((address) => [tonAddressIdentity(address), address] as const),
  );
  const contractsByIdentity = new Map<string, TonCenterNftSaleContractSnapshot>();
  const quarantined: TonCenterQuarantinedNftSaleContract[] = [];
  for (const [rowIndex, raw] of envelope.nftSales.entries()) {
    const reasons = validateNftSaleContractSnapshot(raw);
    let identity: string | undefined;
    if (isObject(raw) && typeof raw.address === "string" && isTonAddress(raw.address)) {
      identity = tonAddressIdentity(raw.address);
      if (!requestedByIdentity.has(identity)) {
        reasons.push("NFT sale contract address was not requested");
      } else if (contractsByIdentity.has(identity)) {
        reasons.push("duplicate NFT sale contract address in response");
      }
    }
    if (reasons.length === 0 && isObject(raw) && identity !== undefined) {
      contractsByIdentity.set(identity, asNftSaleContractSnapshot(raw));
      continue;
    }
    quarantined.push({ raw, reasons, rowIndex });
    diagnostics.push({
      code: "nft_sale_contract_quarantined",
      severity: "error",
      message: `TON Center NFT sale contract row ${rowIndex} failed strict validation`,
      rowIndex,
    });
  }

  const contracts: TonCenterNftSaleContractSnapshot[] = [];
  const missingAddresses: string[] = [];
  for (const address of addresses) {
    const contract = contractsByIdentity.get(tonAddressIdentity(address));
    if (contract) {
      contracts.push(contract);
      continue;
    }
    missingAddresses.push(address);
    diagnostics.push({
      code: "nft_sale_contract_missing",
      severity: "warning",
      message: `TON Center returned no valid NFT sale contract for requested address ${address}`,
    });
  }

  return {
    contracts,
    quarantined,
    missingAddresses,
    diagnostics,
    ...(envelope.addressBook ? { addressBook: envelope.addressBook } : {}),
    ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
    requestUrl,
    fetchedAt: new Date().toISOString(),
    attempts: request.attempts,
    rawCount: envelope.nftSales.length,
  };
}

/**
 * Collect offset pages with deterministic de-duplication by the upstream
 * action_id. No action is transformed into a sale record.
 */
export async function collectTonCenterActions(
  query: TonCenterActionsQuery,
  options: TonCenterCollectOptions,
): Promise<TonCenterActionsCollection> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TonCenterInputError("options must be an object");
  }
  if (options.maxPages === undefined) {
    throw new TonCenterInputError("maxPages is required");
  }
  const maxPages = requireInteger(
    "maxPages",
    options.maxPages,
    1,
    TON_CENTER_MAX_PAGES,
    1,
  );
  const pageDelayMs = requireFiniteNumber(
    "pageDelayMs",
    options.pageDelayMs,
    0,
    MAX_RETRY_DELAY_MS,
    DEFAULT_PAGE_DELAY_MS,
  );
  const normalizedQuery = normalizeQuery(query);
  if (maxPages * normalizedQuery.limit > TON_CENTER_MAX_COLLECTED_ROWS) {
    throw new TonCenterInputError(
      `maxPages * limit must not exceed ${TON_CENTER_MAX_COLLECTED_ROWS}; ` +
        "collect smaller time windows to keep memory bounded",
    );
  }
  // Validate all transport options once, including injectable functions.
  const normalizedOptions = normalizeClientOptions(options);
  const snapshotEndUtime =
    normalizedQuery.endUtime ??
    (normalizedQuery.sort === "desc" && maxPages > 1
      ? Math.max(0, Math.floor(Date.now() / 1_000) - 1)
      : undefined);
  if (snapshotEndUtime !== undefined && snapshotEndUtime > MAX_INT32) {
    throw new TonCenterInputError("snapshot endUtime exceeds the API int32 range");
  }
  const paginatedQuery: TonCenterActionsQuery = {
    ...query,
    ...(snapshotEndUtime !== undefined ? { endUtime: snapshotEndUtime } : {}),
  };
  const pageOptions: TonCenterClientOptions = {
    baseUrl: normalizedOptions.baseUrl,
    ...(normalizedOptions.apiKey ? { apiKey: normalizedOptions.apiKey } : {}),
    timeoutMs: normalizedOptions.timeoutMs,
    maxRetries: normalizedOptions.maxRetries,
    retryBaseDelayMs: normalizedOptions.retryBaseDelayMs,
    maxResponseBytes: normalizedOptions.maxResponseBytes,
    fetchImpl: normalizedOptions.fetchImpl,
    sleepImpl: normalizedOptions.sleepImpl,
  };

  const actions: TonCenterRawAction[] = [];
  const quarantined: TonCenterQuarantinedAction[] = [];
  const diagnostics: TonCenterDiagnostic[] = [];
  const byActionId = new Map<string, CollectedActionState>();
  let currentOffset = normalizedQuery.offset;
  let pagesFetched = 0;
  let nextOffset: number | null = currentOffset;
  let complete = false;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await fetchTonCenterActionsPage(
      {
        ...paginatedQuery,
        limit: normalizedQuery.limit,
        offset: currentOffset,
        sort: normalizedQuery.sort,
      },
      pageOptions,
    );
    pagesFetched++;
    diagnostics.push(
      ...page.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        page: pageNumber,
      })),
    );
    quarantined.push(
      ...page.quarantined.map((candidate) => ({
        ...candidate,
        page: pageNumber,
      })),
    );

    for (const action of page.actions) {
      const serialized = canonicalJson(action);
      const occurrence = actionOccurrence(action);
      const previous = byActionId.get(action.action_id);
      if (previous === undefined) {
        byActionId.set(action.action_id, {
          action,
          canonical: serialized,
          occurrence,
          index: actions.length,
        });
        actions.push(action);
        continue;
      }
      if (previous.canonical === serialized) {
        diagnostics.push({
          code: "duplicate_action_id",
          severity: "warning",
          message: "Duplicate TON Center action_id was ignored",
          page: pageNumber,
          offset: page.offset,
          actionId: action.action_id,
        });
      } else {
        const revisionConflicts = actionRevisionConflicts(previous.action, action);
        const identityConflict =
          previous.occurrence !== occurrence ||
          !optionalIdentityCompatible(
            previous.action.trace_external_hash,
            action.trace_external_hash,
          ) ||
          !optionalIdentityCompatible(
            previous.action.trace_external_hash_norm,
            action.trace_external_hash_norm,
          );
        if (identityConflict || revisionConflicts.length > 0) {
          quarantined.push({
            raw: action,
            reasons: [
              ...(identityConflict
                ? ["action_id conflicts with an earlier occurrence identity"]
                : []),
              ...revisionConflicts.map(
                (conflict) => `action revision has a contradictory scalar: ${conflict}`,
              ),
            ],
            page: pageNumber,
            offset: page.offset,
          });
          diagnostics.push({
            code: "conflicting_action_id",
            severity: "error",
            message: "Conflicting payload for an existing TON Center action_id",
            page: pageNumber,
            offset: page.offset,
            actionId: action.action_id,
          });
        } else {
          const merged = mergeActionRevision(previous.action, action);
          actions[previous.index] = merged;
          byActionId.set(action.action_id, {
            action: merged,
            canonical: canonicalJson(merged),
            occurrence,
            index: previous.index,
          });
          diagnostics.push({
            code: "action_revision_merged",
            severity: "warning",
            message:
              "Compatible revised payload replaced or enriched an earlier TON Center action",
            page: pageNumber,
            offset: page.offset,
            actionId: action.action_id,
          });
        }
      }
    }

    nextOffset = page.nextOffset;
    if (page.complete) {
      complete = true;
      nextOffset = null;
      break;
    }
    if (page.nextOffset === null) {
      throw new TonCenterValidationError(
        "TON Center pagination stopped without a next offset",
        diagnostics,
      );
    }
    currentOffset = page.nextOffset;
    if (pageNumber < maxPages) {
      await normalizedOptions.sleepImpl(pageDelayMs);
    }
  }

  if (!complete) {
    diagnostics.push({
      code: "max_pages_reached",
      severity: "warning",
      message: `Stopped after maxPages=${maxPages}; more raw actions may remain`,
      page: pagesFetched,
      ...(nextOffset !== null ? { offset: nextOffset } : {}),
    });
  }

  return {
    actions,
    quarantined,
    diagnostics,
    pagesFetched,
    ...(snapshotEndUtime !== undefined ? { snapshotEndUtime } : {}),
    complete,
    nextOffset,
  };
}
