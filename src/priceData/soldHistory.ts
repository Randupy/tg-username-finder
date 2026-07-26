import { mkdirSync, writeFileSync } from "node:fs";
import { load, type CheerioAPI } from "cheerio";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface SoldRecord {
  username: string;
  priceTon: number;
  scrapedAt: string;
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
}

const USERNAME_RE = /^[a-z][a-z0-9_]{3,31}$/;

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseTonAmount(value: string): number | null {
  const compact = normalizeText(value).replace(/\s/g, "");
  const normalized =
    /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)
      ? compact.replace(/,/g, "")
      : /^\d+(?:\.\d+)?$/.test(compact)
        ? compact
        : null;
  if (normalized === null) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function findJsonRecords(node: unknown, out: SoldRecord[], scrapedAt: string): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) findJsonRecords(item, out, scrapedAt);
    return;
  }
  const obj = node as Record<string, unknown>;
  const usernameKey = ["username", "name", "handle", "login"].find((k) => typeof obj[k] === "string");
  const priceKey = ["price", "amount", "ton", "value"].find((k) => typeof obj[k] === "number");
  if (usernameKey && priceKey) {
    const username = String(obj[usernameKey]).replace(/^@/, "").toLowerCase();
    const priceTon = Number(obj[priceKey]);
    if (/^[a-z][a-z0-9_]{3,31}$/.test(username) && priceTon > 0) {
      out.push({ username, priceTon, scrapedAt });
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") findJsonRecords(value, out, scrapedAt);
  }
}

function parseEmbeddedJson(html: string, scrapedAt: string): SoldRecord[] {
  const $ = load(html);
  const out: SoldRecord[] = [];
  $("script").each((_, el) => {
    const text = $(el).contents().text();
    if (!text || text.length < 20) return;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      findJsonRecords(parsed, out, scrapedAt);
    } catch {
      // Не JSON или обрезан внутри <script> — ожидаемо для многих тегов, пропускаем.
    }
  });
  return out;
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

function parseSoldTable(html: string, scrapedAt: string): { records: SoldRecord[]; tableRows: number } {
  const $ = load(html);
  const rows = $("tbody.js-autoscroll-body tr, table.tm-table tbody tr");
  const records: SoldRecord[] = [];
  const seen = new Set<string>();

  rows.each((_, row) => {
    const hasSoldStatus = $(row)
      .find(".tm-status-unavail, .table-cell-status-thin, .table-cell-value")
      .toArray()
      .some((el) => /^sold$/i.test(normalizeText($(el).text())));
    const tonElements = $(row).find(".icon-ton");
    const salePriceElements = tonElements
      .filter((__, el) => /\bsale price\b/i.test(normalizeText($(el).closest("td").text())));

    // Fragment also uses .icon-ton for minimum bids. Require sale semantics.
    if (!hasSoldStatus && salePriceElements.length === 0) return;

    const username = usernameFromRow($, row);
    const priceElement = (salePriceElements.length > 0 ? salePriceElements : tonElements).first();
    const priceTon = parseTonAmount(priceElement.text());
    if (!username || priceTon === null || seen.has(username)) return;

    seen.add(username);
    records.push({ username, priceTon, scrapedAt });
  });

  return { records, tableRows: rows.length };
}

function parseTextFallback(html: string, scrapedAt: string): SoldRecord[] {
  const $ = load(html);
  const text = $("body").text().replace(/\s+/g, " ");
  const out: SoldRecord[] = [];
  const re = /@([a-zA-Z][a-zA-Z0-9_]{3,31})[^@]{0,60}?(\d+(?:\.\d+)?)\s*(?:ton|gram)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ username: m[1].toLowerCase(), priceTon: parseFloat(m[2]), scrapedAt });
  }
  return out;
}

export function parseSoldHistoryPage(html: string, scrapedAt: string): SoldPageParseResult {
  const filter = detectListingFilter(html);
  const table = parseSoldTable(html, scrapedAt);

  // Явный глобальный фильтр надёжнее текста отдельных строк.
  if (filter === "auction" || filter === "sale") {
    return { records: [], filter, tableRows: table.tableRows };
  }

  if (table.records.length > 0) {
    return { records: table.records, filter, tableRows: table.tableRows };
  }

  // Никогда не применяем общие эвристики к явно несоответствующему листингу:
  // иначе minimum bid активного аукциона станет фиктивной ценой продажи.
  if (filter !== "sold") {
    return { records: [], filter, tableRows: table.tableRows };
  }

  let records = parseEmbeddedJson(html, scrapedAt);
  if (records.length === 0) records = parseTextFallback(html, scrapedAt);
  return { records, filter, tableRows: table.tableRows };
}

interface FetchedPage {
  html: string;
  finalUrl: string;
}

async function fetchPage(url: string, debug?: boolean, debugName?: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
  });
  const html = await res.text();
  if (debug) {
    mkdirSync("debug", { recursive: true });
    writeFileSync(`debug/sold-${debugName ?? Date.now()}.html`, html, "utf-8");
  }
  if (!res.ok) {
    throw new Error(`Fragment ответил HTTP ${res.status} ${res.statusText}`.trim());
  }
  return { html, finalUrl: res.url || url };
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
}

export async function collectSoldHistory(opts: CollectOptions): Promise<SoldRecord[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const diversifyDefaultViews = opts.baseUrl === undefined;
  const all: SoldRecord[] = [];
  const seen = new Set<string>();

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
      fetched = await fetchPage(url, opts.debug, `page${page}`);
    } catch (err) {
      console.error(`Не удалось загрузить страницу ${page}: ${err instanceof Error ? err.message : err}`);
      break;
    }

    const parsed = parseSoldHistoryPage(fetched.html, scrapedAt);
    const records = parsed.records;

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
      break;
    }

    let newOnPage = 0;
    for (const r of records) {
      if (!seen.has(r.username)) {
        seen.add(r.username);
        all.push(r);
        newOnPage++;
      }
    }
    console.log(`Страница ${page}: найдено записей ${records.length}, новых — ${newOnPage}`);
    if (newOnPage === 0) break; // либо конец списка, либо пагинация работает не так, как предполагалось

    if (page < opts.maxPages) await sleep(opts.delayMs);
  }

  return all;
}
