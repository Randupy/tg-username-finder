import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTonCenterActionsUrl,
  buildTonCenterNftSalesUrl,
  collectTonCenterActions,
  fetchTonCenterActionsPage,
  fetchTonCenterNftSaleContracts,
  TonCenterHttpError,
  TonCenterInputError,
  TonCenterTransportError,
  TonCenterValidationError,
} from "../src/priceData/tonCenter.js";

const SALE_CONTRACT = `0:${"1".repeat(64)}`;
const OTHER_SALE_CONTRACT = `0:${"2".repeat(64)}`;
const NFT_ADDRESS = `0:${"a".repeat(64)}`;
const MARKETPLACE_ADDRESS = `0:${"b".repeat(64)}`;

function action(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action_id: id,
    type: "auction_bid",
    details: {
      amount: "1000000000",
      bidder: "0:bidder",
      opaque_future_field: { nested: true },
    },
    start_lt: "100",
    end_lt: "101",
    start_utime: 1_700_000_000,
    end_utime: 1_700_000_001,
    success: true,
    trace_id: `trace-${id}`,
    trace_end_lt: "102",
    trace_end_utime: 1_700_000_002,
    trace_mc_seqno_end: 42,
    transactions: [`tx-${id}`],
    finality: 2,
    ...overrides,
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("builds the official actions query and preserves validated raw details", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const raw = action("action-1", {
    accounts: ["0:account"],
    type: "future_parser_action",
  });
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      actions: [raw],
      address_book: { "0:account": { user_friendly: "EQ..." } },
      metadata: { "0:nft": { is_indexed: true } },
    });
  }) as typeof fetch;

  const page = await fetchTonCenterActionsPage(
    {
      account: "0:account",
      txHashes: ["tx-a", "tx-b"],
      actionTypes: ["auction_bid"],
      supportedActionTypes: ["latest"],
      includeAccounts: true,
      startLt: 1n,
      endLt: "1000",
      limit: 1,
      offset: 5,
      sort: "asc",
    },
    {
      baseUrl: "https://example.test/api/v3",
      apiKey: "free-test-key",
      maxRetries: 0,
      fetchImpl: fakeFetch,
    },
  );

  assert.equal(requests.length, 1);
  const requested = new URL(requests[0].url);
  assert.equal(requested.origin + requested.pathname, "https://example.test/api/v3/actions");
  assert.equal(requested.searchParams.get("account"), "0:account");
  assert.deepEqual(requested.searchParams.getAll("tx_hash"), ["tx-a", "tx-b"]);
  assert.deepEqual(requested.searchParams.getAll("action_type"), ["auction_bid"]);
  assert.deepEqual(requested.searchParams.getAll("supported_action_types"), ["latest"]);
  assert.equal(requested.searchParams.get("include_accounts"), "true");
  assert.equal(requested.searchParams.get("start_lt"), "1");
  assert.equal(requested.searchParams.get("end_lt"), "1000");
  assert.equal(requested.searchParams.get("limit"), "1");
  assert.equal(requested.searchParams.get("offset"), "5");
  assert.equal(requested.searchParams.get("sort"), "asc");
  assert.equal(requested.searchParams.has("api_key"), false);

  const headers = new Headers(requests[0].init?.headers);
  assert.equal(headers.get("X-API-Key"), "free-test-key");
  assert.equal(headers.get("Accept"), "application/json");
  assert.ok(requests[0].init?.signal instanceof AbortSignal);
  assert.equal(requests[0].init?.redirect, "error");

  assert.equal(page.actions.length, 1);
  assert.equal(page.actions[0].type, "future_parser_action");
  assert.deepEqual(page.actions[0].details, raw.details);
  assert.equal(page.quarantined.length, 0);
  assert.deepEqual(page.addressBook, {
    "0:account": { user_friendly: "EQ..." },
  });
  assert.equal(page.complete, false);
  assert.equal(page.nextOffset, 6);
});

test("reads NFT sale-contract state without promoting it to a completed sale", async () => {
  const requests: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return jsonResponse({
      nft_sales: [
        {
          address: SALE_CONTRACT,
          code_hash: "code-hash",
          created_at: 1_700_000_000,
          data_hash: "data-hash",
          details: {
            full_price: "1000000000",
            sold: true,
          },
          last_transaction_lt: "123456789",
          marketplace_address: MARKETPLACE_ADDRESS,
          nft_address: NFT_ADDRESS,
          nft_item: { address: NFT_ADDRESS, index: "42" },
          nft_owner_address: `0:${"c".repeat(64)}`,
          type: "getgems_sale",
        },
        {
          address: OTHER_SALE_CONTRACT,
          created_at: "1700000000",
          details: {},
          last_transaction_lt: "10",
          nft_address: NFT_ADDRESS,
          type: "getgems_sale",
        },
      ],
      metadata: { [NFT_ADDRESS]: { name: "asset" } },
    });
  }) as typeof fetch;

  const response = await fetchTonCenterNftSaleContracts(
    { addresses: [SALE_CONTRACT, OTHER_SALE_CONTRACT] },
    {
      baseUrl: "https://example.test/api/v3",
      maxRetries: 0,
      fetchImpl: fakeFetch,
    },
  );

  assert.equal(requests.length, 1);
  const requested = new URL(requests[0]);
  assert.equal(
    requested.origin + requested.pathname,
    "https://example.test/api/v3/nft/sales",
  );
  assert.deepEqual(requested.searchParams.getAll("address"), [
    SALE_CONTRACT,
    OTHER_SALE_CONTRACT,
  ]);
  assert.equal(response.contracts.length, 1);
  assert.equal(response.quarantined.length, 1);
  assert.deepEqual(response.missingAddresses, [OTHER_SALE_CONTRACT]);
  assert.match(response.quarantined[0].reasons.join(" "), /created_at/);
  assert.equal(response.contracts[0].evidenceKind, "nft-sale-contract-state");
  assert.equal(response.contracts[0].provesCompletedSale, false);
  assert.deepEqual(response.contracts[0].details, {
    full_price: "1000000000",
    sold: true,
  });
  assert.equal(Object.hasOwn(response.contracts[0], "eventAt"), false);
  assert.equal(Object.hasOwn(response.contracts[0], "priceTon"), false);
  assert.deepEqual(response.metadata, { [NFT_ADDRESS]: { name: "asset" } });
  assert.deepEqual(
    response.diagnostics.map((item) => item.code),
    ["nft_sale_contract_quarantined", "nft_sale_contract_missing"],
  );
});

test("quarantines foreign and duplicate NFT contracts and reports requested misses", async () => {
  const snapshot = (address: string, suffix: string) => ({
    address,
    created_at: 1_700_000_000,
    details: { state: suffix },
    last_transaction_lt: "10",
    nft_address: NFT_ADDRESS,
    type: "getgems_sale",
  });
  const foreign = `0:${"3".repeat(64)}`;
  const fakeFetch = (async () =>
    jsonResponse({
      nft_sales: [
        snapshot(SALE_CONTRACT, "accepted"),
        snapshot(SALE_CONTRACT, "duplicate"),
        snapshot(foreign, "foreign"),
      ],
    })) as typeof fetch;

  const response = await fetchTonCenterNftSaleContracts(
    { addresses: [SALE_CONTRACT, OTHER_SALE_CONTRACT] },
    { maxRetries: 0, fetchImpl: fakeFetch },
  );

  assert.deepEqual(response.contracts.map((item) => item.address), [SALE_CONTRACT]);
  assert.deepEqual(response.missingAddresses, [OTHER_SALE_CONTRACT]);
  assert.equal(response.quarantined.length, 2);
  assert.match(response.quarantined[0].reasons.join(" "), /duplicate/);
  assert.match(response.quarantined[1].reasons.join(" "), /not requested/);
  assert.deepEqual(
    response.diagnostics.map((item) => item.code),
    [
      "nft_sale_contract_quarantined",
      "nft_sale_contract_quarantined",
      "nft_sale_contract_missing",
    ],
  );
});

test("hard-validates the bounded NFT sale-contract query", async () => {
  assert.equal(
    buildTonCenterNftSalesUrl({ addresses: [SALE_CONTRACT, SALE_CONTRACT] }),
    `https://toncenter.com/api/v3/nft/sales?address=${encodeURIComponent(SALE_CONTRACT)}`,
  );
  assert.throws(
    () => buildTonCenterNftSalesUrl({ addresses: [] }),
    TonCenterInputError,
  );
  assert.throws(
    () => buildTonCenterNftSalesUrl({ addresses: ["not-an-address"] }),
    /TON addresses/,
  );
  assert.throws(
    () =>
      buildTonCenterNftSalesUrl({
        addresses: Array.from({ length: 1_001 }, (_, index) =>
          `0:${index.toString(16).padStart(64, "0")}`,
        ),
      }),
    /at most 1000/,
  );

  const shouldNotRun = (async () => {
    throw new Error("fetch must not run for invalid input");
  }) as typeof fetch;
  await assert.rejects(
    fetchTonCenterNftSaleContracts(
      { addresses: [] },
      { fetchImpl: shouldNotRun },
    ),
    TonCenterInputError,
  );
});

test("uses offset pagination and stops on the first short page", async () => {
  const offsets: number[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    if (offset === 3) {
      return jsonResponse({ actions: [action("a"), action("b")] });
    }
    if (offset === 5) {
      return jsonResponse({ actions: [action("c")] });
    }
    throw new Error(`unexpected offset ${offset}`);
  }) as typeof fetch;

  const result = await collectTonCenterActions(
    { account: "0:account", limit: 2, offset: 3, endUtime: 1_800_000_000 },
    {
      maxPages: 5,
      pageDelayMs: 7,
      maxRetries: 0,
      fetchImpl: fakeFetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

  assert.deepEqual(offsets, [3, 5]);
  assert.deepEqual(sleeps, [7]);
  assert.deepEqual(
    result.actions.map((item) => item.action_id),
    ["a", "b", "c"],
  );
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.complete, true);
  assert.equal(result.nextOffset, null);
  assert.equal(result.quarantined.length, 0);
});

test("quarantines malformed rows without inventing sale records", async () => {
  const malformed = action("bad", {
    success: "true",
    start_lt: "200",
    end_lt: "100",
  });
  const futureType = action("future", { type: "nft_transfer_v2" });
  const fakeFetch = (async () =>
    jsonResponse({ actions: [action("good"), malformed, futureType] })) as typeof fetch;

  const page = await fetchTonCenterActionsPage(
    { limit: 10 },
    { maxRetries: 0, fetchImpl: fakeFetch },
  );

  assert.deepEqual(
    page.actions.map((item) => item.action_id),
    ["good", "future"],
  );
  assert.equal(page.quarantined.length, 1);
  assert.equal(page.quarantined[0].rowIndex, 1);
  assert.match(page.quarantined[0].reasons.join(" "), /success must be boolean/);
  assert.match(page.quarantined[0].reasons.join(" "), /start_lt must not exceed end_lt/);
  assert.deepEqual(
    page.diagnostics.map((item) => item.code),
    ["action_quarantined"],
  );
  assert.equal(
    Object.hasOwn(page.actions[0] as unknown as object, "priceTon"),
    false,
  );
});

test("rejects malformed response envelopes and oversized pages", async (t) => {
  await t.test("missing actions array", async () => {
    const fakeFetch = (async () => jsonResponse({ result: [] })) as typeof fetch;
    await assert.rejects(
      fetchTonCenterActionsPage(
        { limit: 10 },
        { maxRetries: 0, fetchImpl: fakeFetch },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TonCenterValidationError);
        assert.match(error.message, /actions array/);
        return true;
      },
    );
  });

  await t.test("more rows than requested limit", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ actions: [action("a"), action("b")] })) as typeof fetch;
    await assert.rejects(
      fetchTonCenterActionsPage(
        { limit: 1 },
        { maxRetries: 0, fetchImpl: fakeFetch },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TonCenterValidationError);
        assert.match(error.message, /returned 2 actions for limit=1/);
        return true;
      },
    );
  });

  await t.test("declared response size is rejected before body consumption", async () => {
    let bodyRead = false;
    const fakeFetch = (async () => {
      const response = jsonResponse(
        { actions: [] },
        200,
        { "Content-Length": "2000" },
      );
      const originalText = response.text.bind(response);
      response.text = async () => {
        bodyRead = true;
        return originalText();
      };
      return response;
    }) as typeof fetch;
    await assert.rejects(
      fetchTonCenterActionsPage(
        {},
        { maxRetries: 0, maxResponseBytes: 1_024, fetchImpl: fakeFetch },
      ),
      /exceeds maxResponseBytes=1024/,
    );
    assert.equal(bodyRead, false);
  });

  await t.test("streamed response is stopped at the byte limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(700)));
        controller.enqueue(new TextEncoder().encode("y".repeat(700)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fakeFetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    await assert.rejects(
      fetchTonCenterActionsPage(
        {},
        { maxRetries: 0, maxResponseBytes: 1_024, fetchImpl: fakeFetch },
      ),
      /exceeds maxResponseBytes=1024/,
    );
    assert.equal(cancelled, true);
  });
});

test("honors Retry-After and reports retry diagnostics", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fakeFetch = (async () => {
    attempts++;
    if (attempts === 1) {
      return jsonResponse(
        { code: 429, error: "rate limit" },
        429,
        { "Retry-After": "2" },
      );
    }
    return jsonResponse({ actions: [] });
  }) as typeof fetch;

  const page = await fetchTonCenterActionsPage(
    { limit: 10 },
    {
      maxRetries: 1,
      retryBaseDelayMs: 5,
      fetchImpl: fakeFetch,
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2_000]);
  assert.equal(page.attempts, 2);
  assert.equal(page.diagnostics.length, 1);
  assert.deepEqual(page.diagnostics[0], {
    code: "retry_scheduled",
    severity: "warning",
    message: "TON Center request failed; retry 2 scheduled",
    offset: 0,
    attempt: 1,
    status: 429,
    retryDelayMs: 2_000,
  });
});

test("uses capped exponential backoff for transient transport failures", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fakeFetch = (async () => {
    attempts++;
    if (attempts < 3) throw new TypeError("temporary socket failure");
    return jsonResponse({ actions: [] });
  }) as typeof fetch;

  const page = await fetchTonCenterActionsPage(
    {},
    {
      maxRetries: 2,
      retryBaseDelayMs: 40_000,
      fetchImpl: fakeFetch,
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
    },
  );

  assert.equal(page.attempts, 3);
  assert.deepEqual(delays, [40_000, 60_000]);
  assert.deepEqual(
    page.diagnostics.map((item) => item.retryDelayMs),
    [40_000, 60_000],
  );
});

test("does not retry permanent authentication failures", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fakeFetch = (async () => {
    attempts++;
    return jsonResponse({ code: 401, error: "bad key" }, 401);
  }) as typeof fetch;

  await assert.rejects(
    fetchTonCenterActionsPage(
      {},
      {
        maxRetries: 3,
        fetchImpl: fakeFetch,
        sleepImpl: async (ms) => {
          delays.push(ms);
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TonCenterHttpError);
      assert.equal(error.status, 401);
      assert.match(error.message, /bad key/);
      return true;
    },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("enforces request timeout through the injected fetch signal", async () => {
  const fakeFetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) =>
    await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;

  await assert.rejects(
    fetchTonCenterActionsPage(
      {},
      { timeoutMs: 5, maxRetries: 0, fetchImpl: fakeFetch },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TonCenterTransportError);
      assert.match(error.message, /timed out|timeout|aborted/i);
      return true;
    },
  );
});

test("deduplicates shifted pages and reports a max-page boundary", async () => {
  const snapshotBounds: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get("offset"));
    snapshotBounds.push(url.searchParams.get("end_utime") ?? "");
    return offset === 0
      ? jsonResponse({ actions: [action("a"), action("b")] })
      : jsonResponse({ actions: [action("b"), action("c")] });
  }) as typeof fetch;

  const result = await collectTonCenterActions(
    { limit: 2 },
    {
      maxPages: 2,
      pageDelayMs: 0,
      maxRetries: 0,
      fetchImpl: fakeFetch,
      sleepImpl: async () => {},
    },
  );

  assert.deepEqual(
    result.actions.map((item) => item.action_id),
    ["a", "b", "c"],
  );
  assert.equal(result.complete, false);
  assert.equal(result.nextOffset, 4);
  assert.equal(snapshotBounds.length, 2);
  assert.ok(snapshotBounds[0]);
  assert.equal(snapshotBounds[0], snapshotBounds[1]);
  assert.equal(result.snapshotEndUtime, Number(snapshotBounds[0]));
  assert.ok(result.diagnostics.some((item) => item.code === "duplicate_action_id"));
  assert.ok(result.diagnostics.some((item) => item.code === "max_pages_reached"));
});

test("canonicalizes duplicates and handles upstream revisions without synthesis", async (t) => {
  await t.test("object key order does not create a false conflict", async () => {
    const original = action("same");
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    const fakeFetch = (async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 0
        ? jsonResponse({ actions: [original, action("filler")] })
        : jsonResponse({ actions: [reordered] });
    }) as typeof fetch;
    const result = await collectTonCenterActions(
      { limit: 2, endUtime: 1_800_000_000 },
      { maxPages: 2, pageDelayMs: 0, maxRetries: 0, fetchImpl: fakeFetch },
    );
    assert.equal(result.actions.length, 2);
    assert.equal(result.quarantined.length, 0);
    assert.ok(result.diagnostics.some((item) => item.code === "duplicate_action_id"));
    assert.equal(
      result.diagnostics.some((item) => item.code === "conflicting_action_id"),
      false,
    );
  });

  await t.test("later compatible enrichment replaces stale first payload", async () => {
    const first = action("revision", {
      details: { amount: "1000000000" },
      accounts: ["0:first"],
      finality: 0,
    });
    const revised = action("revision", {
      details: { buyer: "0:buyer" },
      accounts: ["0:second"],
      finality: 2,
    });
    const fakeFetch = (async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 0
        ? jsonResponse({ actions: [first, action("filler")] })
        : jsonResponse({ actions: [revised] });
    }) as typeof fetch;
    const result = await collectTonCenterActions(
      { limit: 2, endUtime: 1_800_000_000 },
      { maxPages: 2, pageDelayMs: 0, maxRetries: 0, fetchImpl: fakeFetch },
    );
    const merged = result.actions.find((item) => item.action_id === "revision");
    assert.ok(merged);
    assert.equal(merged.finality, 2);
    assert.deepEqual(merged.accounts, ["0:first", "0:second"]);
    assert.deepEqual(merged.details, {
      amount: "1000000000",
      buyer: "0:buyer",
    });
    assert.equal(result.quarantined.length, 0);
    assert.ok(
      result.diagnostics.some((item) => item.code === "action_revision_merged"),
    );
  });

  await t.test("a contradictory lower-finality revision is quarantined whole", async () => {
    const finalized = action("finalized-revision", {
      details: {
        amount: "1000000000",
        state: "final",
        nested: { verified: true },
      },
      accounts: ["0:final"],
      finality: 2,
    });
    const staleButRicher = action("finalized-revision", {
      details: {
        amount: "1",
        state: "pending",
        nested: { verified: false, note: "additional-non-conflicting-field" },
        supplemental: "preserved",
      },
      accounts: ["0:pending"],
      finality: 1,
    });
    const fakeFetch = (async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 0
        ? jsonResponse({ actions: [finalized, action("filler")] })
        : jsonResponse({ actions: [staleButRicher] });
    }) as typeof fetch;
    const result = await collectTonCenterActions(
      { limit: 2, endUtime: 1_800_000_000 },
      { maxPages: 2, pageDelayMs: 0, maxRetries: 0, fetchImpl: fakeFetch },
    );
    const retained = result.actions.find(
      (item) => item.action_id === "finalized-revision",
    );
    assert.ok(retained);
    assert.equal(retained.finality, 2);
    assert.deepEqual(retained.accounts, ["0:final"]);
    assert.deepEqual(retained.details, {
      amount: "1000000000",
      state: "final",
      nested: { verified: true },
    });
    assert.equal(result.quarantined.length, 1);
    assert.match(result.quarantined[0].reasons.join(" "), /contradictory scalar/);
    assert.match(result.quarantined[0].reasons.join(" "), /details\.amount/);
    assert.equal(
      result.diagnostics.some(
        (item) =>
          item.code === "action_revision_merged" &&
          item.actionId === "finalized-revision",
      ),
      false,
    );
  });

  await t.test("immutable occurrence conflicts remain quarantined", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return offset === 0
        ? jsonResponse({ actions: [action("conflict"), action("filler")] })
        : jsonResponse({ actions: [action("conflict", { trace_id: "other-trace" })] });
    }) as typeof fetch;
    const result = await collectTonCenterActions(
      { limit: 2, endUtime: 1_800_000_000 },
      { maxPages: 2, pageDelayMs: 0, maxRetries: 0, fetchImpl: fakeFetch },
    );
    assert.equal(result.actions.length, 2);
    assert.equal(result.quarantined.length, 1);
    assert.ok(result.diagnostics.some((item) => item.code === "conflicting_action_id"));
  });
});

test("hard-validates query, credentials, and collection bounds", async () => {
  assert.throws(
    () => buildTonCenterActionsUrl({ limit: 1_001 }),
    (error: unknown) => error instanceof TonCenterInputError,
  );
  assert.throws(
    () => buildTonCenterActionsUrl({ startUtime: 20, endUtime: 10 }),
    /startUtime must not exceed endUtime/,
  );
  assert.throws(
    () =>
      buildTonCenterActionsUrl(
        {},
        "https://user:password@example.test/api/v3",
      ),
    /without credentials/,
  );

  const shouldNotRun = (async () => {
    throw new Error("fetch must not run for invalid input");
  }) as typeof fetch;
  await assert.rejects(
    fetchTonCenterActionsPage(
      {},
      { apiKey: "bad\r\nheader", fetchImpl: shouldNotRun },
    ),
    (error: unknown) => error instanceof TonCenterInputError,
  );
  await assert.rejects(
    collectTonCenterActions(
      {},
      { maxPages: 0, fetchImpl: shouldNotRun },
    ),
    (error: unknown) => error instanceof TonCenterInputError,
  );
  await assert.rejects(
    collectTonCenterActions(
      {},
      { fetchImpl: shouldNotRun } as never,
    ),
    /maxPages is required/,
  );
  await assert.rejects(
    collectTonCenterActions(
      { limit: 1_000 },
      { maxPages: 251, fetchImpl: shouldNotRun },
    ),
    /maxPages \* limit must not exceed 250000/,
  );
  await assert.rejects(
    collectTonCenterActions(
      { limit: 1 },
      { maxPages: 1_001, fetchImpl: shouldNotRun },
    ),
    /maxPages must be a safe integer in \[1, 1000\]/,
  );
});
