import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fetchFreshRates, getRates } from "../src/rates.js";

const TON_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd,rub";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("gets TON/USD and TON/RUB from one CoinGecko request", async () => {
  const requested: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url === TON_URL) {
      return jsonResponse({ "the-open-network": { usd: 3.25, rub: 258.2125 } });
    }
    return jsonResponse({ message: "not found" }, 404);
  }) as typeof fetch;

  const rates = await fetchFreshRates(fakeFetch);

  assert.deepEqual(requested, [TON_URL]);
  assert.equal(rates.tonUsd, 3.25);
  assert.ok(Math.abs(rates.usdRub - 79.45) < 1e-10);
  assert.ok(Number.isFinite(new Date(rates.fetchedAt).getTime()));
});

test("rejects obsolete or malformed rate response shapes", async () => {
  const fakeFetch = (async () =>
    jsonResponse({ "the-open-network": { usd: 3.25 } })) as typeof fetch;

  await assert.rejects(
    fetchFreshRates(fakeFetch),
    /Не удалось разобрать USD\/RUB-котировки TON/,
  );
});

test("surfaces upstream HTTP failures", async () => {
  const fakeFetch = (async () =>
    jsonResponse({ message: "unavailable" }, 503)) as typeof fetch;

  await assert.rejects(fetchFreshRates(fakeFetch), /CoinGecko вернул статус 503/);
});

test("repeated getRates uses stale cache without repeating a failed network request", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "tg-rates-backoff-"));
  const previousDirectory = process.cwd();
  mkdirSync(resolve(directory, "data"));
  const stale = {
    tonUsd: 3.1,
    usdRub: 80,
    fetchedAt: "2025-01-01T00:00:00.000Z",
  };
  writeFileSync(
    resolve(directory, "data", "rates-cache.json"),
    JSON.stringify(stale),
    "utf8",
  );
  let requests = 0;
  const unavailableFetch = (async () => {
    requests++;
    throw new Error("upstream timeout");
  }) as typeof fetch;

  try {
    process.chdir(directory);
    assert.deepEqual(await getRates(false, unavailableFetch), stale);
    assert.deepEqual(await getRates(false, unavailableFetch), stale);
    assert.equal(requests, 1);
  } finally {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  }
});
