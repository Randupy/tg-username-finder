import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildCollectionPageUrl,
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
        </tr>
        <tr class="tm-row-selectable">
          <td><a href="/username/alpha"><div class="tm-value">@alpha</div></a></td>
          <td>
            <div class="tm-value icon-ton">12&nbsp;345.75</div>
            <div class="table-cell-desc">Sale price</div>
          </td>
          <td><div class="tm-status-unavail">Sold</div></td>
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
  assert.deepEqual(result.records, [
    { username: "danbao", priceTon: 1_583_948, scrapedAt: SCRAPED_AT },
    { username: "alpha", priceTon: 12_345.75, scrapedAt: SCRAPED_AT },
  ]);
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
