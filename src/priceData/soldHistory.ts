import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { load, type CheerioAPI } from "cheerio";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 60_000;

export type SoldRecordSource = "fragment";
export type SoldRecordConfidence = "high" | "medium" | "low";
export type SoldRecordParser =
  | "fragment-sold-table"
  | "fragment-embedded-json"
  | "fragment-text";

export interface SoldRecordProvenance {
  parser: SoldRecordParser;
  sourceUrl?: string;
  requestedUrl?: string;
  /** Canonical Fragment detail page for the username, when linked by the row. */
  assetUrl?: string;
  page?: number;
  rowIndex?: number;
}

export interface SoldRecord {
  username: string;
  priceTon: number;
  scrapedAt: string;
  /**
   * Real sale timestamp reported by Fragment. Optional so historical
   * `{ username, priceTon, scrapedAt }` files remain valid.
   */
  saleAt?: string;
  source?: SoldRecordSource;
  view?: string;
  provenance?: SoldRecordProvenance;
  confidence?: SoldRecordConfidence;
  /**
   * Stable event identity. Two sales of the same username at different times
   * have different IDs and must not overwrite one another.
   */
  eventId?: string;
}

export interface QuarantinedSoldCandidate {
  username?: string;
  rawPrice?: string;
  reason: string;
  provenance: SoldRecordProvenance;
}

export interface SoldPageContext {
  sourceUrl?: string;
  requestedUrl?: string;
  page?: number;
  view?: string;
}

/**
 * Публичного API истории продаж у Fragment нет. Основная стратегия ниже
 * разбирает серверную HTML-таблицу: username берётся из ссылки/первой ячейки,
 * цена — только из TON-элемента строки, явно помеченной как Sold/Sale price.
 * Это не позволяет случайно принять минимальные ставки активных аукционов за
 * цены продаж. JSON и текст оставлены лишь как ограниченные запасные стратегии.
 */
export const DEFAULT_BASE_URL = "https://fragment.com/?filter=sold&sort=price_desc";
const DEFAULT_SORT_VIEWS = ["price_desc", "price_asc", "listed", "ending"] as const;

type ListingFilter = "sold" | "auction" | "sale" | "unknown";

export interface SoldPageParseResult {
  records: SoldRecord[];
  filter: ListingFilter;
  tableRows: number;
  view?: string;
  /** Always populated by the current parser; optional for source compatibility. */
  quarantined?: QuarantinedSoldCandidate[];
}

const USERNAME_RE = /^[a-z][a-z0-9_]{3,31}$/;

function normalizeText(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
}

function parseTonAmount(value: string): number | null {
  const compact = normalizeText(value)
    .replace(/\s*(?:ton|gram)\s*$/i, "")
    .replace(/[\s'’]/g, "");
  if (!/^\d[\d.,]*$/.test(compact)) return null;

  let normalized: string | null = null;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) {
    // Fragment's English view: 1,583,948 or 12,345.75.
    normalized = compact.replace(/,/g, "");
  } else if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(compact)) {
    // Locale-style thousands + decimal comma: 12.345,75.
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(compact)) {
    // Multiple dot-separated thousands groups are unambiguous.
    normalized = compact.replace(/\./g, "");
  } else if (/^\d+,\d+$/.test(compact)) {
    const [, fraction = ""] = compact.split(",");
    // A single three-digit comma group is the common thousands form.
    normalized = fraction.length === 3 ? compact.replace(",", "") : compact.replace(",", ".");
  } else if (/^\d+(?:\.\d+)?$/.test(compact)) {
    normalized = compact;
  }

  if (normalized === null) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function buildSoldEventId(
  record: Pick<SoldRecord, "username" | "priceTon" | "scrapedAt" | "saleAt" | "source">,
): string {
  const source = record.source ?? "fragment";
  const username = record.username.toLowerCase();
  const discriminator = record.saleAt
    ? `sale:${canonicalTimestamp(record.saleAt) ?? record.saleAt}`
    : `observed-price:${Number(record.priceTon)}`;
  const digest = createHash("sha256")
    .update(`${source}\0${username}\0${discriminator}`)
    .digest("hex")
    .slice(0, 32);
  return `${source}:${digest}`;
}

function provenanceFor(
  parser: SoldRecordParser,
  context: SoldPageContext,
  rowIndex?: number,
  assetUrl?: string,
): SoldRecordProvenance {
  return {
    parser,
    ...(context.sourceUrl ? { sourceUrl: context.sourceUrl } : {}),
    ...(context.requestedUrl ? { requestedUrl: context.requestedUrl } : {}),
    ...(assetUrl ? { assetUrl } : {}),
    ...(context.page !== undefined ? { page: context.page } : {}),
    ...(rowIndex !== undefined ? { rowIndex } : {}),
  };
}

function canonicalFragmentAssetUrl(
  $: CheerioAPI,
  row: ReturnType<CheerioAPI>[number],
  username: string,
): string | undefined {
  const href = $(row).find("a[href^='/username/']").first().attr("href");
  const pathMatch = href?.match(/^\/username\/([^/?#]+)(?:[?#].*)?$/i);
  if (!pathMatch) return undefined;
  let linkedUsername: string;
  try {
    linkedUsername = decodeURIComponent(pathMatch[1]).toLowerCase();
  } catch {
    return undefined;
  }
  if (linkedUsername !== username || !USERNAME_RE.test(linkedUsername)) {
    return undefined;
  }
  return `https://fragment.com/username/${linkedUsername}`;
}

function makeSoldRecord(
  username: string,
  priceTon: number,
  scrapedAt: string,
  saleAt: string | undefined,
  confidence: SoldRecordConfidence,
  provenance: SoldRecordProvenance,
  view?: string,
): SoldRecord {
  const record: SoldRecord = {
    username,
    priceTon,
    scrapedAt,
    ...(saleAt ? { saleAt } : {}),
    source: "fragment",
    ...(view ? { view } : {}),
    provenance,
    confidence,
  };
  // Observation time is not an occurrence identity. Only exact-dated sales
  // receive a stable legacy event id; observation-only rows remain uncertain.
  if (saleAt) record.eventId = buildSoldEventId(record);
  return record;
}

interface FallbackParseResult {
  records: SoldRecord[];
  quarantined: QuarantinedSoldCandidate[];
}

function findJsonRecords(
  node: unknown,
  out: SoldRecord[],
  quarantined: QuarantinedSoldCandidate[],
  scrapedAt: string,
  context: SoldPageContext,
  view?: string,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      findJsonRecords(item, out, quarantined, scrapedAt, context, view);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  const usernameKey = ["username", "handle"].find((key) => typeof obj[key] === "string");
  const priceKey = ["priceTon", "salePriceTon", "sale_price_ton"].find(
    (key) => typeof obj[key] === "number" || typeof obj[key] === "string",
  );

  if (usernameKey && priceKey) {
    const username = String(obj[usernameKey]).replace(/^@/, "").toLowerCase();
    const priceTon = parseTonAmount(String(obj[priceKey]));
    const saleAtKey = ["saleAt", "soldAt", "sold_at", "date"].find(
      (key) => typeof obj[key] === "string",
    );
    const saleAt = saleAtKey ? canonicalTimestamp(obj[saleAtKey]) : null;
    const status = String(obj.status ?? obj.state ?? obj.type ?? "").toLowerCase();
    const hasSoldEvidence =
      /\bsold\b/.test(status) || priceKey === "salePriceTon" || priceKey === "sale_price_ton";
    const provenance = provenanceFor("fragment-embedded-json", context);

    if (USERNAME_RE.test(username) && priceTon !== null && saleAt && hasSoldEvidence) {
      out.push(
        makeSoldRecord(
          username,
          priceTon,
          scrapedAt,
          saleAt,
          "medium",
          provenance,
          view,
        ),
      );
    } else if (USERNAME_RE.test(username) && priceTon !== null) {
      quarantined.push({
        username,
        rawPrice: String(obj[priceKey]),
        reason: !saleAt
          ? "embedded JSON has no exact sale timestamp"
          : "embedded JSON has no explicit sold/sale-price evidence",
        provenance,
      });
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      findJsonRecords(value, out, quarantined, scrapedAt, context, view);
    }
  }
}

function parseEmbeddedJson(
  html: string,
  scrapedAt: string,
  context: SoldPageContext,
  view?: string,
): FallbackParseResult {
  const $ = load(html);
  const out: SoldRecord[] = [];
  const quarantined: QuarantinedSoldCandidate[] = [];
  $("script").each((_, el) => {
    const text = $(el).contents().text();
    if (!text || text.length < 20) return;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      findJsonRecords(parsed, out, quarantined, scrapedAt, context, view);
    } catch {
      // Не JSON или обрезан внутри <script> — ожидаемо для многих тегов, пропускаем.
    }
  });
  return { records: out, quarantined };
}

function detectListingFilter(html: string): ListingFilter {
  const $ = load(html);
  const hiddenFilter = $("form input[name='filter']").first().attr("value")?.toLowerCase();
  const selectedFilter = $(".dropdown-menu li.selected [data-field='filter']")
    .first()
    .attr("data-value")
    ?.toLowerCase();
  const value = hiddenFilter || selectedFilter;
  return value === "sold" || value === "auction" || value === "sale" ? value : "unknown";
}

function detectListingView(html: string, context: SoldPageContext): string | undefined {
  if (context.view?.trim()) return context.view.trim().toLowerCase();
  const $ = load(html);
  const hiddenSort = $("form input[name='sort']").first().attr("value");
  const selectedSort = $(".dropdown-menu li.selected [data-field='sort']")
    .first()
    .attr("data-value");
  const fromMarkup = hiddenSort || selectedSort;
  if (fromMarkup?.trim()) return fromMarkup.trim().toLowerCase();

  for (const candidate of [context.sourceUrl, context.requestedUrl]) {
    if (!candidate) continue;
    try {
      const fromUrl = new URL(candidate).searchParams.get("sort");
      if (fromUrl?.trim()) return fromUrl.trim().toLowerCase();
    } catch {
      // Provenance URL is optional; malformed metadata must not break parsing.
    }
  }
  return undefined;
}

function usernameFromRow(
  $: CheerioAPI,
  row: ReturnType<CheerioAPI>[number],
): string | null {
  const displayed = normalizeText($(row).find(".table-cell-value-row .tm-value").first().text())
    .replace(/^@/, "")
    .toLowerCase();
  if (USERNAME_RE.test(displayed)) return displayed;

  const href = $(row).find("a[href^='/username/']").first().attr("href");
  const pathMatch = href?.match(/^\/username\/([^/?#]+)/i);
  if (!pathMatch) return null;
  let fromPath: string;
  try {
    fromPath = decodeURIComponent(pathMatch[1]).toLowerCase();
  } catch {
    return null;
  }
  return USERNAME_RE.test(fromPath) ? fromPath : null;
}

interface ParsedSoldTable extends FallbackParseResult {
  tableRows: number;
}

function saleTimestampFromRow(
  $: CheerioAPI,
  row: ReturnType<CheerioAPI>[number],
): { saleAt?: string; ambiguous: boolean; invalid: boolean } {
  const timeElements = $(row).find("time[datetime]").toArray();
  const allTimes = timeElements
    .map((element) => canonicalTimestamp($(element).attr("datetime")))
    .filter((value): value is string => value !== null);
  const soldCellTimes = $(row)
    .find("td")
    .toArray()
    .filter((cell) => /\bsold\b/i.test(normalizeText($(cell).text())))
    .flatMap((cell) =>
      $(cell)
        .find("time[datetime]")
        .toArray()
        .map((element) => canonicalTimestamp($(element).attr("datetime")))
        .filter((value): value is string => value !== null),
    );
  const candidates = [...new Set(soldCellTimes.length > 0 ? soldCellTimes : allTimes)];
  const invalid = timeElements.length > allTimes.length;
  if (candidates.length === 1) {
    return { saleAt: candidates[0], ambiguous: false, invalid };
  }
  return { ambiguous: candidates.length > 1, invalid };
}

function parseSoldTable(
  html: string,
  scrapedAt: string,
  context: SoldPageContext,
  view?: string,
): ParsedSoldTable {
  const $ = load(html);
  const rows = $("tbody.js-autoscroll-body tr, table.tm-table tbody tr");
  const records: SoldRecord[] = [];
  const quarantined: QuarantinedSoldCandidate[] = [];

  rows.each((rowIndex, row) => {
    const hasSoldStatus = $(row)
      .find(".tm-status-unavail, .table-cell-status-thin, .table-cell-value")
      .toArray()
      .some((el) => /^sold$/i.test(normalizeText($(el).text())));
    const tonCandidates = $(row)
      .find(".icon-ton")
      .toArray()
      .map((element) => ({
        raw: normalizeText($(element).text()),
        amount: parseTonAmount($(element).text()),
        isSalePrice: /sale\s*price/i.test(
          normalizeText($(element).closest("td").text()),
        ),
      }))
      .filter(
        (candidate): candidate is { raw: string; amount: number; isSalePrice: boolean } =>
          candidate.amount !== null,
      );
    const explicitSalePrices = tonCandidates.filter((candidate) => candidate.isSalePrice);

    // Fragment also uses .icon-ton for minimum bids. Require sale semantics.
    if (!hasSoldStatus && explicitSalePrices.length === 0) return;

    const username = usernameFromRow($, row);
    if (!username) return;
    const provenance = provenanceFor(
      "fragment-sold-table",
      context,
      rowIndex,
      canonicalFragmentAssetUrl($, row, username),
    );
    const timestamp = saleTimestampFromRow($, row);
    if (timestamp.invalid) {
      quarantined.push({
        username,
        reason: "sold row contains an invalid <time datetime> value",
        provenance,
      });
      return;
    }
    if (timestamp.ambiguous) {
      quarantined.push({
        username,
        reason: "sold row contains multiple distinct sale timestamps",
        provenance,
      });
      return;
    }

    const explicitAmounts = [...new Set(explicitSalePrices.map((candidate) => candidate.amount))];
    const allAmounts = [...new Set(tonCandidates.map((candidate) => candidate.amount))];
    let priceTon: number | undefined;
    let confidence: SoldRecordConfidence;

    if (explicitAmounts.length === 1) {
      priceTon = explicitAmounts[0];
      confidence = timestamp.saleAt ? "high" : "medium";
    } else if (explicitAmounts.length > 1) {
      quarantined.push({
        username,
        rawPrice: explicitSalePrices.map((candidate) => candidate.raw).join(" | "),
        reason: "sold row contains conflicting explicit Sale price values",
        provenance,
      });
      return;
    } else if (hasSoldStatus && allAmounts.length === 1) {
      // Backward-compatible fallback for older table markup with a single TON
      // value and explicit Sold status, but no English "Sale price" label.
      priceTon = allAmounts[0];
      confidence = "medium";
    } else {
      quarantined.push({
        username,
        rawPrice: tonCandidates.map((candidate) => candidate.raw).join(" | ") || undefined,
        reason:
          allAmounts.length > 1
            ? "sold row has multiple TON values but no unique Sale price"
            : "sold row has no parseable TON sale price",
        provenance,
      });
      return;
    }

    const record = makeSoldRecord(
      username,
      priceTon,
      scrapedAt,
      timestamp.saleAt,
      confidence,
      provenance,
      view,
    );
    records.push(record);
  });

  return { records, quarantined, tableRows: rows.length };
}

function parseTextFallback(
  html: string,
  scrapedAt: string,
  context: SoldPageContext,
  view?: string,
): FallbackParseResult {
  const $ = load(html);
  const text = normalizeText($("body").text());
  const out: SoldRecord[] = [];
  const quarantined: QuarantinedSoldCandidate[] = [];
  const re =
    /@([a-zA-Z][a-zA-Z0-9_]{3,31})([^@]{0,180}?)(\d[\d\s\u00a0\u202f,'’.]*?(?:[.,]\d+)?)\s*(?:ton|gram)\b/gi;
  const pageTimes = [...new Set(
    $("time[datetime]")
      .toArray()
      .map((element) => canonicalTimestamp($(element).attr("datetime")))
      .filter((value): value is string => value !== null),
  )];
  const matches: Array<{
    username: string;
    rawPrice: string;
    priceTon: number;
    hasSaleEvidence: boolean;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const username = m[1].toLowerCase();
    const priceTon = parseTonAmount(m[3]);
    if (!USERNAME_RE.test(username) || priceTon === null) continue;
    const evidence = normalizeText(m[2]);
    matches.push({
      username,
      rawPrice: m[3],
      priceTon,
      hasSaleEvidence: /\bsale\s+price\b/i.test(evidence) && /\bsold\b/i.test(evidence),
    });
  }

  for (const candidate of matches) {
    const provenance = provenanceFor("fragment-text", context);
    // Text strips the DOM relationship between each username and timestamp.
    // Accept only a single, explicitly sold candidate with one exact time.
    if (matches.length === 1 && pageTimes.length === 1 && candidate.hasSaleEvidence) {
      out.push(
        makeSoldRecord(
          candidate.username,
          candidate.priceTon,
          scrapedAt,
          pageTimes[0],
          "low",
          provenance,
          view,
        ),
      );
    } else {
      quarantined.push({
        username: candidate.username,
        rawPrice: candidate.rawPrice,
        reason: !candidate.hasSaleEvidence
          ? "text fallback has no explicit Sold + Sale price evidence"
          : "text fallback cannot associate exactly one sale timestamp with the candidate",
        provenance,
      });
    }
  }
  return { records: out, quarantined };
}

function sameImmutableSoldEvidence(left: SoldRecord, right: SoldRecord): boolean {
  return (
    left.username.toLowerCase() === right.username.toLowerCase() &&
    left.priceTon === right.priceTon &&
    (left.saleAt ? canonicalTimestamp(left.saleAt) : null) ===
      (right.saleAt ? canonicalTimestamp(right.saleAt) : null)
  );
}

function immutableSoldEvidenceKey(record: SoldRecord): string {
  return JSON.stringify({
    username: record.username.toLowerCase(),
    priceTon: record.priceTon,
    saleAt: record.saleAt ? canonicalTimestamp(record.saleAt) : null,
  });
}

function deterministicSoldRecordKey(record: SoldRecord): string {
  return JSON.stringify({
    immutable: immutableSoldEvidenceKey(record),
    scrapedAt: record.scrapedAt,
    source: record.source ?? null,
    view: record.view ?? null,
    confidence: record.confidence ?? null,
    eventId: record.eventId ?? null,
    provenance: record.provenance
      ? {
          parser: record.provenance.parser,
          sourceUrl: record.provenance.sourceUrl ?? null,
          requestedUrl: record.provenance.requestedUrl ?? null,
          assetUrl: record.provenance.assetUrl ?? null,
          page: record.provenance.page ?? null,
          rowIndex: record.provenance.rowIndex ?? null,
        }
      : null,
  });
}

function uniqueEvents(
  records: readonly SoldRecord[],
  quarantined: QuarantinedSoldCandidate[],
): SoldRecord[] {
  const groups = new Map<string, SoldRecord[]>();
  for (const record of records) {
    const key = record.eventId ?? buildSoldEventId(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const conflictingKeys = new Set<string>();
  for (const [key, group] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const first = group[0];
    if (group.every((record) => sameImmutableSoldEvidence(first, record))) continue;
    conflictingKeys.add(key);
    const variants = [...new Set(group.map(immutableSoldEvidenceKey))].sort();
    const reason =
      `duplicate exact event identity ${key} has conflicting immutable evidence; ` +
      `the entire identity was quarantined (${variants.join(" | ")})`;
    for (const record of [...group].sort((left, right) =>
      deterministicSoldRecordKey(left).localeCompare(deterministicSoldRecordKey(right)),
    )) {
      if (!record.provenance) {
        throw new Error(`Parsed sold record ${key} is missing provenance`);
      }
      quarantined.push({
        username: record.username,
        rawPrice: String(record.priceTon),
        reason,
        provenance: record.provenance,
      });
    }
  }

  const unique: SoldRecord[] = [];
  const emitted = new Set<string>();
  for (const record of records) {
    const key = record.eventId ?? buildSoldEventId(record);
    if (conflictingKeys.has(key) || emitted.has(key)) continue;
    const representative = [...(groups.get(key) ?? [record])].sort((left, right) =>
      deterministicSoldRecordKey(left).localeCompare(deterministicSoldRecordKey(right)),
    )[0];
    unique.push(representative);
    emitted.add(key);
  }
  return unique;
}

export function parseSoldHistoryPage(
  html: string,
  scrapedAt: string,
  context: SoldPageContext = {},
): SoldPageParseResult {
  const filter = detectListingFilter(html);
  const view = detectListingView(html, context) ?? "unknown";
  const table = parseSoldTable(html, scrapedAt, context, view);

  // Явный глобальный фильтр надёжнее текста отдельных строк.
  if (filter === "auction" || filter === "sale") {
    return {
      records: [],
      filter,
      tableRows: table.tableRows,
      ...(view ? { view } : {}),
      quarantined: table.quarantined,
    };
  }

  if (table.records.length > 0) {
    const records = uniqueEvents(table.records, table.quarantined);
    return {
      records,
      filter,
      tableRows: table.tableRows,
      ...(view ? { view } : {}),
      quarantined: table.quarantined,
    };
  }

  // Никогда не применяем общие эвристики к явно несоответствующему листингу:
  // иначе minimum bid активного аукциона станет фиктивной ценой продажи.
  if (filter !== "sold") {
    return {
      records: [],
      filter,
      tableRows: table.tableRows,
      ...(view ? { view } : {}),
      quarantined: table.quarantined,
    };
  }

  // Existing table rows are stronger evidence than broad page fallbacks. If
  // they were rejected as ambiguous, keep them quarantined instead of trying
  // to rediscover the same values through unrelated JSON/body text.
  if (table.tableRows > 0) {
    return {
      records: [],
      filter,
      tableRows: table.tableRows,
      ...(view ? { view } : {}),
      quarantined: table.quarantined,
    };
  }

  const embedded = parseEmbeddedJson(html, scrapedAt, context, view);
  const text =
    embedded.records.length === 0
      ? parseTextFallback(html, scrapedAt, context, view)
      : { records: [], quarantined: [] };
  const quarantined = [
    ...table.quarantined,
    ...embedded.quarantined,
    ...text.quarantined,
  ];
  const records = uniqueEvents(
    embedded.records.length > 0 ? embedded.records : text.records,
    quarantined,
  );
  return {
    records,
    filter,
    tableRows: table.tableRows,
    ...(view ? { view } : {}),
    quarantined,
  };
}

interface FetchedPage {
  html: string;
  finalUrl: string;
}

class FragmentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    statusText?: string,
  ) {
    super(`Fragment ответил HTTP ${status} ${statusText ?? ""}`.trim());
  }
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

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof FragmentHttpError)) return true;
  return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
}

interface FetchPageOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  sleepImpl: (ms: number) => Promise<void>;
  debug?: boolean;
  debugName?: string;
}

async function fetchPageOnce(
  url: string,
  opts: FetchPageOptions,
): Promise<FetchedPage> {
  const res = await opts.fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const html = await res.text();
  if (opts.debug) {
    mkdirSync("debug", { recursive: true });
    writeFileSync(`debug/sold-${opts.debugName ?? Date.now()}.html`, html, "utf-8");
  }
  if (!res.ok) {
    throw new FragmentHttpError(
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
      res.statusText,
    );
  }
  return { html, finalUrl: res.url || url };
}

async function fetchPage(
  url: string,
  opts: FetchPageOptions,
): Promise<FetchedPage> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fetchPageOnce(url, opts);
    } catch (error) {
      lastError = error;
      if (attempt >= opts.maxRetries || !isRetryableFetchError(error)) break;
      const retryAfterMs =
        error instanceof FragmentHttpError ? error.retryAfterMs : undefined;
      const backoffMs = Math.min(
        MAX_RETRY_DELAY_MS,
        Math.max(
          retryAfterMs ?? 0,
          opts.retryBaseDelayMs * 2 ** attempt,
        ),
      );
      console.error(
        `Fragment: попытка ${attempt + 1} не удалась ` +
          `(${error instanceof Error ? error.message : error}), ` +
          `повтор через ${Math.round(backoffMs)} мс.`,
      );
      await opts.sleepImpl(backoffMs);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildCollectionPageUrl(
  baseUrl: string,
  page: number,
  diversifyDefaultViews = false,
): string {
  const url = new URL(baseUrl);
  if (diversifyDefaultViews && page <= DEFAULT_SORT_VIEWS.length) {
    // Fragment сейчас игнорирует `page=` и каждый раз отдаёт те же 500 строк.
    // Для стандартного запуска обходим четыре реальные сортировки: верх/низ
    // рынка и временные срезы. Это даёт модели гораздо менее смещённую выборку.
    url.searchParams.set("sort", DEFAULT_SORT_VIEWS[page - 1]);
    url.searchParams.delete("page");
  } else if (page > 1) {
    url.searchParams.set("page", String(page));
  }
  return url.toString();
}

export interface CollectOptions {
  baseUrl?: string; // на случай, если реальный адрес окажется другим
  maxPages: number;
  delayMs: number;
  debug?: boolean;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Dependency injection for deterministic collector tests. */
  fetchImpl?: typeof fetch;
  /** Dependency injection for retry/backoff tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function collectSoldHistory(opts: CollectOptions): Promise<SoldRecord[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const diversifyDefaultViews = opts.baseUrl === undefined;
  const all: SoldRecord[] = [];
  const seen = new Map<string, SoldRecord>();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  const requestTimeoutMs =
    Number.isFinite(opts.requestTimeoutMs) && (opts.requestTimeoutMs ?? 0) > 0
      ? opts.requestTimeoutMs!
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries =
    Number.isSafeInteger(opts.maxRetries) && (opts.maxRetries ?? -1) >= 0
      ? opts.maxRetries!
      : DEFAULT_MAX_RETRIES;
  const retryBaseDelayMs =
    Number.isFinite(opts.retryBaseDelayMs) && (opts.retryBaseDelayMs ?? -1) >= 0
      ? opts.retryBaseDelayMs!
      : DEFAULT_RETRY_BASE_DELAY_MS;

  for (let page = 1; page <= opts.maxPages; page++) {
    let url: string;
    try {
      url = buildCollectionPageUrl(baseUrl, page, diversifyDefaultViews);
    } catch {
      console.error(`Некорректный адрес листинга Fragment: ${baseUrl}`);
      break;
    }
    const scrapedAt = new Date().toISOString();
    let fetched: FetchedPage;
    try {
      fetched = await fetchPage(url, {
        fetchImpl,
        timeoutMs: requestTimeoutMs,
        maxRetries,
        retryBaseDelayMs,
        sleepImpl,
        debug: opts.debug,
        debugName: `page${page}`,
      });
    } catch (err) {
      console.error(`Не удалось загрузить страницу ${page}: ${err instanceof Error ? err.message : err}`);
      break;
    }

    let view: string | undefined;
    try {
      view = new URL(url).searchParams.get("sort") ?? undefined;
    } catch {
      // URL уже был успешно построен выше; оставляем защиту для custom URL implementations.
    }
    const parsed = parseSoldHistoryPage(fetched.html, scrapedAt, {
      sourceUrl: fetched.finalUrl,
      requestedUrl: url,
      page,
      view,
    });
    const records = parsed.records;
    const quarantinedCount = parsed.quarantined?.length ?? 0;
    if (quarantinedCount > 0) {
      console.error(
        `Страница ${page}: неоднозначных записей помещено в quarantine — ` +
          `${quarantinedCount}; они не попадут в обучение.`,
      );
    }

    if (records.length === 0) {
      if (parsed.filter !== "sold" && parsed.filter !== "unknown") {
        console.error(
          `Страница ${page}: Fragment вернул листинг "${parsed.filter}" вместо "sold" ` +
            `(итоговый адрес: ${fetched.finalUrl}). Проверьте --base-url или перенаправление.`,
        );
        break;
      }
      console.log(
        `Страница ${page}: не найдено ни одной продажи ` +
          `(строк таблицы: ${parsed.tableRows}, итоговый адрес: ${fetched.finalUrl}). ` +
          "Запустите с --debug и проверьте сохранённый HTML в ./debug/.",
      );
      if (
        diversifyDefaultViews &&
        page < opts.maxPages &&
        page < DEFAULT_SORT_VIEWS.length
      ) {
        await sleepImpl(opts.delayMs);
        continue;
      }
      break;
    }

    let newOnPage = 0;
    for (const r of records) {
      const eventKey = r.eventId ?? buildSoldEventId(r);
      const previous = seen.get(eventKey);
      if (!previous) {
        seen.set(eventKey, r);
        all.push(r);
        newOnPage++;
      } else if (!sameImmutableSoldEvidence(previous, r)) {
        throw new Error(
          `Conflicting immutable evidence for duplicate exact event identity ${eventKey}: ` +
            `${previous.username}/${previous.priceTon}/${previous.saleAt ?? "unknown"} vs ` +
            `${r.username}/${r.priceTon}/${r.saleAt ?? "unknown"}`,
        );
      }
    }
    console.log(`Страница ${page}: найдено записей ${records.length}, новых — ${newOnPage}`);
    if (
      newOnPage === 0 &&
      (!diversifyDefaultViews || page >= DEFAULT_SORT_VIEWS.length)
    ) {
      break; // конец списка или custom-пагинация возвращает уже виденные события
    }

    if (page < opts.maxPages) await sleepImpl(opts.delayMs);
  }

  return all;
}
