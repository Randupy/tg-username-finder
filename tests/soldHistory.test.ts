import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildCollectionPageUrl,
  collectSoldHistory,
  parseSoldHistoryPage,
} from "../src/priceData/soldHistory.js";

const SCRAPED_AT = "2026-07-27T00:00:00.000Z";

test("parses current Fragment sold rows without treating other TON amounts as prices", () => {
  const html = `
    <form>
      <input type="hidden" name="filter" value="sold">
    </form>
    <table class="tm-table">
      <tbody class="js-autoscroll-body">
        <tr class="tm-row-selectable">
          <td>
            <a href="/username/danbao">
              <div class="table-cell-value-row">
                <div class="table-cell-value tm-value">@DanBao</div>
                <div class="table-cell-status-thin tm-status-unavail">Sold</div>
              </div>
            </a>
          </td>
           <td>
             <div class="table-cell-value tm-value icon-before icon-ton">1,583,948</div>
             <div class="table-cell-desc">Sale price</div>
           </td>
           <td><div class="tm-status-unavail">Sold</div><time datetime="2026-02-07T17:04:13+00:00"></time></td>
         </tr>
         <tr class="tm-row-selectable">
           <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
          <td>
            <div class="tm-value icon-ton">12&nbsp;345.75</div>
             <div class="table-cell-desc">Sale price</div>
           </td>
           <td><div class="tm-status-unavail">Sold</div><time datetime="2025-01-02T03:04:05Z"></time></td>
         </tr>
        <tr class="tm-row-selectable">
          <td><a href="/username/bidonly"><div class="tm-value">@bidonly</div></a></td>
          <td><div class="tm-value icon-ton">999,999</div><div>Minimum bid</div></td>
          <td><div>On auction</div></td>
        </tr>
      </tbody>
    </table>
    <div class="popup"><span class="icon-ton">1,000</span></div>
  `;

  const result = parseSoldHistoryPage(html, SCRAPED_AT);

  assert.equal(result.filter, "sold");
  assert.equal(result.tableRows, 3);
  assert.deepEqual(
    result.records.map((record) => ({
      username: record.username,
      priceTon: record.priceTon,
      scrapedAt: record.scrapedAt,
      saleAt: record.saleAt,
      source: record.source,
      confidence: record.confidence,
      parser: record.provenance?.parser,
      assetUrl: record.provenance?.assetUrl,
      rowIndex: record.provenance?.rowIndex,
    })),
    [
      {
        username: "danbao",
        priceTon: 1_583_948,
        scrapedAt: SCRAPED_AT,
        saleAt: "2026-02-07T17:04:13.000Z",
        source: "fragment",
        confidence: "high",
        parser: "fragment-sold-table",
        assetUrl: "https://fragment.com/username/danbao",
        rowIndex: 0,
      },
      {
        username: "alpha",
        priceTon: 12_345.75,
        scrapedAt: SCRAPED_AT,
        saleAt: "2025-01-02T03:04:05.000Z",
        source: "fragment",
        confidence: "high",
        parser: "fragment-sold-table",
        assetUrl: "https://fragment.com/username/alpha",
        rowIndex: 1,
      },
    ],
  );
  assert.ok(result.records.every((record) => /^fragment:[a-f0-9]{32}$/.test(record.eventId ?? "")));
  assert.equal(result.quarantined.length, 0);
});

test("does not turn active-auction minimum bids into sold history", () => {
  const html = `
    <form><input type="hidden" name="filter" value=""></form>
    <ul class="dropdown-menu">
      <li class="selected">
        <a data-field="filter" data-value="auction">On auction</a>
      </li>
    </ul>
    <table class="tm-table">
      <tbody class="js-autoscroll-body">
        <tr>
          <td><a href="/username/sold"><div class="tm-value">@sold</div></a></td>
          <td><div class="tm-value icon-ton">320,250</div><div>Minimum bid</div></td>
        </tr>
      </tbody>
    </table>
  `;

  const result = parseSoldHistoryPage(html, SCRAPED_AT);

  assert.equal(result.filter, "auction");
  assert.equal(result.tableRows, 1);
  assert.deepEqual(result.records, []);
});

const savedDebugHtml = resolve("debug", "sold-page1.html");
test(
  "parses the current real Fragment debug listing without mixing listing types",
  { skip: !existsSync(savedDebugHtml) },
  () => {
    const result = parseSoldHistoryPage(readFileSync(savedDebugHtml, "utf8"), SCRAPED_AT);

    assert.ok(result.tableRows > 0);
    assert.ok(result.filter === "auction" || result.filter === "sold");
    if (result.filter === "auction") {
      assert.deepEqual(result.records, []);
    } else {
      assert.ok(result.records.length > 0);
      assert.ok(result.records.every((record) => record.priceTon > 0));
    }
  },
);

test("adds pagination through URLSearchParams without corrupting the query", () => {
  const url = new URL(
    buildCollectionPageUrl("https://fragment.com/?filter=sold&sort=price_desc", 3),
  );

  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("filter"), "sold");
  assert.equal(url.searchParams.get("sort"), "price_desc");
  assert.equal(url.searchParams.get("page"), "3");
});

test("uses diverse sold-listing views for the default multi-page collection", () => {
  const first = new URL(
    buildCollectionPageUrl(
      "https://fragment.com/?filter=sold&sort=price_desc",
      1,
      true,
    ),
  );
  const second = new URL(
    buildCollectionPageUrl(
      "https://fragment.com/?filter=sold&sort=price_desc",
      2,
      true,
    ),
  );
  const third = new URL(
    buildCollectionPageUrl(
      "https://fragment.com/?filter=sold&sort=price_desc",
      3,
      true,
    ),
  );

  assert.equal(first.searchParams.get("sort"), "price_desc");
  assert.equal(second.searchParams.get("sort"), "price_asc");
  assert.equal(third.searchParams.get("sort"), "listed");
  assert.equal(second.searchParams.get("page"), null);
});

test("selects an explicit Sale price when a sold row contains several TON values", () => {
  const html = `
    <form><input name="filter" value="sold"><input name="sort" value="ending"></form>
    <table class="tm-table"><tbody>
      <tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">10</span><div>Minimum bid</div></td>
        <td><span class="icon-ton">12 345.75</span><div>Sale price</div></td>
        <td><div class="tm-status-unavail">Sold</div><time datetime="2025-03-04T05:06:07+00:00"></time></td>
      </tr>
    </tbody></table>
  `;

  const result = parseSoldHistoryPage(html, SCRAPED_AT);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].priceTon, 12_345.75);
  assert.equal(result.records[0].saleAt, "2025-03-04T05:06:07.000Z");
  assert.equal(result.records[0].view, "ending");
  assert.equal(result.records[0].confidence, "high");
  assert.deepEqual(result.quarantined, []);
});

test("quarantines a sold row with several unlabeled TON values", () => {
  const html = `
    <form><input name="filter" value="sold"></form>
    <table class="tm-table"><tbody>
      <tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">10</span><div>Minimum bid</div></td>
        <td><span class="icon-ton">999</span><div>Final amount</div></td>
        <td><div class="tm-status-unavail">Sold</div><time datetime="2025-03-04T05:06:07Z"></time></td>
      </tr>
    </tbody></table>
  `;

  const result = parseSoldHistoryPage(html, SCRAPED_AT);
  assert.deepEqual(result.records, []);
  assert.equal(result.quarantined.length, 1);
  assert.match(result.quarantined[0].reason, /multiple TON values/);
});

test("quarantines a malformed exact sale timestamp", () => {
  const result = parseSoldHistoryPage(
    `<form><input name="filter" value="sold"></form>
     <table class="tm-table"><tbody><tr>
       <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
       <td><span class="icon-ton">100</span><div>Sale price</div></td>
       <td><span class="tm-status-unavail">Sold</span><time datetime="not-a-date"></time></td>
     </tr></tbody></table>`,
    SCRAPED_AT,
  );

  assert.deepEqual(result.records, []);
  assert.equal(result.quarantined?.length, 1);
  assert.match(result.quarantined?.[0].reason ?? "", /invalid <time datetime>/);
});

test("parses common thousands and decimal separators without truncating prices", () => {
  const html = `
    <form><input name="filter" value="sold"></form>
    <table class="tm-table"><tbody>
      <tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">12&nbsp;345.75</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span></td>
      </tr>
      <tr>
        <td><a href="/username/bravo"><div class="tm-value">@bravo</div></a></td>
        <td><span class="icon-ton">12.345,75</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span></td>
      </tr>
      <tr>
        <td><a href="/username/charlie"><div class="tm-value">@charlie</div></a></td>
        <td><span class="icon-ton">1’234</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span></td>
      </tr>
    </tbody></table>
  `;

  const result = parseSoldHistoryPage(html, SCRAPED_AT);
  assert.deepEqual(result.records.map((record) => record.priceTon), [12_345.75, 12_345.75, 1_234]);
});

test("keeps repeated sales of the same username as distinct table events", () => {
  const html = `
    <form><input name="filter" value="sold"></form>
    <table class="tm-table"><tbody>
      <tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">100</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span><time datetime="2024-01-01T00:00:00Z"></time></td>
      </tr>
      <tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">250</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span><time datetime="2025-01-01T00:00:00Z"></time></td>
      </tr>
    </tbody></table>
  `;

  const result = parseSoldHistoryPage(html, SCRAPED_AT);
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].eventId, result.records[1].eventId);
});

test("quarantines every version of a conflicting exact identity independent of row order", () => {
  const row = (price: number) => `
    <tr>
      <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
      <td><span class="icon-ton">${price}</span><div>Sale price</div></td>
      <td><span class="tm-status-unavail">Sold</span><time datetime="2025-01-01T00:00:00Z"></time></td>
    </tr>`;
  const page = (prices: readonly number[]) => `
    <form><input name="filter" value="sold"></form>
    <table class="tm-table"><tbody>${prices.map(row).join("")}</tbody></table>`;

  const forward = parseSoldHistoryPage(page([100, 999]), SCRAPED_AT);
  const reversed = parseSoldHistoryPage(page([999, 100]), SCRAPED_AT);

  for (const result of [forward, reversed]) {
    assert.deepEqual(result.records, []);
    assert.equal(result.quarantined.length, 2);
    assert.deepEqual(
      result.quarantined.map((candidate) => candidate.rawPrice),
      ["100", "999"],
    );
    assert.ok(
      result.quarantined.every((candidate) =>
        /duplicate exact event identity/.test(candidate.reason),
      ),
    );
    assert.ok(
      result.quarantined.every((candidate) =>
        /entire identity was quarantined/.test(candidate.reason),
      ),
    );
  }
  assert.deepEqual(
    forward.quarantined.map(({ rawPrice, reason }) => ({ rawPrice, reason })),
    reversed.quarantined.map(({ rawPrice, reason }) => ({ rawPrice, reason })),
  );
});

test("quarantines ambiguous fallback labels instead of inventing a sale", () => {
  const embedded = parseSoldHistoryPage(
    `<form><input name="filter" value="sold"></form>
     <script type="application/json">{"username":"alpha","priceTon":123}</script>`,
    SCRAPED_AT,
  );
  assert.deepEqual(embedded.records, []);
  assert.equal(embedded.quarantined.length, 1);
  assert.match(embedded.quarantined[0].reason, /no exact sale timestamp/);

  const text = parseSoldHistoryPage(
    `<form><input name="filter" value="sold"></form><body>@alpha paid 12,345 TON</body>`,
    SCRAPED_AT,
  );
  assert.deepEqual(text.records, []);
  assert.equal(text.quarantined.length, 1);
  assert.equal(text.quarantined[0].rawPrice?.replace(/\s/g, ""), "12,345");
});

test("collector retries transient HTTP failures and records request provenance", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fakeFetch = (async () => {
    attempts++;
    if (attempts === 1) return new Response("temporary", { status: 503 });
    return new Response(`
      <form><input name="filter" value="sold"><input name="sort" value="price_desc"></form>
      <table class="tm-table"><tbody><tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">1,234</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span><time datetime="2025-01-02T03:04:05Z"></time></td>
      </tr></tbody></table>
    `, { status: 200 });
  }) as typeof fetch;

  const records = await collectSoldHistory({
    maxPages: 1,
    delayMs: 0,
    maxRetries: 1,
    retryBaseDelayMs: 7,
    requestTimeoutMs: 1_000,
    fetchImpl: fakeFetch,
    sleepImpl: async (ms) => {
      delays.push(ms);
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [7]);
  assert.equal(records.length, 1);
  assert.equal(records[0].priceTon, 1_234);
  assert.equal(records[0].view, "price_desc");
  assert.equal(records[0].provenance?.page, 1);
  assert.match(records[0].provenance?.requestedUrl ?? "", /filter=sold/);
});

test("collector continues across default sort views after an empty view", async () => {
  const requestedUrls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    if (requestedUrls.length === 1) {
      return new Response(
        `<form><input name="filter" value="sold"><input name="sort" value="price_desc"></form>`,
        { status: 200 },
      );
    }
    return new Response(`
      <form><input name="filter" value="sold"><input name="sort" value="price_asc"></form>
      <table class="tm-table"><tbody><tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">1,234</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span><time datetime="2025-01-02T03:04:05Z"></time></td>
      </tr></tbody></table>
    `, { status: 200 });
  }) as typeof fetch;

  const records = await collectSoldHistory({
    maxPages: 2,
    delayMs: 0,
    maxRetries: 0,
    fetchImpl: fakeFetch,
    sleepImpl: async () => {},
  });

  assert.equal(requestedUrls.length, 2);
  assert.equal(new URL(requestedUrls[0]).searchParams.get("sort"), "price_desc");
  assert.equal(new URL(requestedUrls[1]).searchParams.get("sort"), "price_asc");
  assert.equal(records.length, 1);
  assert.equal(records[0].view, "price_asc");
});

test("collector rejects conflicting immutable evidence for one exact event across views", async () => {
  let page = 0;
  const fakeFetch = (async () => {
    const price = page++ === 0 ? "100" : "999";
    return new Response(`
      <form><input name="filter" value="sold"></form>
      <table class="tm-table"><tbody><tr>
        <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
        <td><span class="icon-ton">${price}</span><div>Sale price</div></td>
        <td><span class="tm-status-unavail">Sold</span><time datetime="2025-01-02T03:04:05Z"></time></td>
      </tr></tbody></table>
    `, { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    collectSoldHistory({
      maxPages: 2,
      delayMs: 0,
      maxRetries: 0,
      fetchImpl: fakeFetch,
      sleepImpl: async () => {},
    }),
    /Conflicting immutable evidence for duplicate exact event identity/,
  );
});
