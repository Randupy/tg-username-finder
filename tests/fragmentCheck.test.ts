import assert from "node:assert/strict";
import test from "node:test";
import { checkFragment } from "../src/checkers/fragmentCheck.js";

let fetchMockQueue = Promise.resolve();

async function withFetchResponse(
  response: Response | (() => Promise<Response>),
  run: () => Promise<void>,
): Promise<void> {
  let releaseQueue!: () => void;
  const previous = fetchMockQueue;
  fetchMockQueue = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  });
  await previous;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    typeof response === "function" ? response() : response) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    releaseQueue();
  }
}

function htmlResponse(body: string, status = 200, statusText = ""): Response {
  return new Response(`<html><body>${body}</body></html>`, { status, statusText });
}

function htmlResponseAt(url: string, body: string): Response {
  const response = htmlResponse(body);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("does not report transport and anti-bot responses as available", async (t) => {
  await t.test("HTTP 429", async () => {
    await withFetchResponse(
      htmlResponse("Too Many Requests", 429, "Too Many Requests"),
      async () => {
        const result = await checkFragment("abcde");
        assert.equal(result.available, "unknown");
        assert.equal(result.confidence, "low");
        assert.match(result.detail ?? "", /HTTP 429/);
      },
    );
  });

  await t.test("HTTP 500", async () => {
    await withFetchResponse(
      htmlResponse("Internal Server Error", 500, "Internal Server Error"),
      async () => {
        const result = await checkFragment("abcde");
        assert.equal(result.available, "unknown");
        assert.match(result.detail ?? "", /HTTP 500/);
      },
    );
  });

  await t.test("Cloudflare challenge with HTTP 200", async () => {
    await withFetchResponse(
      htmlResponse(`
        <div id="challenge-platform">Just a moment...</div>
        <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
      `),
      async () => {
        const result = await checkFragment("abcde");
        assert.equal(result.available, "unknown");
        assert.equal(result.confidence, "low");
        assert.match(result.detail ?? "", /anti-bot|Cloudflare/i);
      },
    );
  });
});

test("preserves confirmed Fragment occupied signal", async () => {
  await withFetchResponse(
    htmlResponse("Someone already claimed this username on Telegram."),
    async () => {
      const result = await checkFragment("abcde");
      assert.equal(result.available, false);
      assert.equal(result.confidence, "high");
      assert.match(result.detail ?? "", /не выставлено на продажу/i);
    },
  );
});

test("recognizes current Fragment detail and search-fallback states", async (t) => {
  await t.test("active auction detail page", async () => {
    await withFetchResponse(
      htmlResponseAt(
        "https://fragment.com/username/activebid",
        `<section class="tm-section-header">
          <div class="tm-section-header-status tm-status-avail">On auction</div>
        </section>`,
      ),
      async () => {
        const result = await checkFragment("activebid");
        assert.equal(result.available, false);
        assert.equal(result.confidence, "high");
        assert.match(result.detail ?? "", /on auction/i);
      },
    );
  });

  await t.test("exact search redirect without collectible listing", async () => {
    await withFetchResponse(
      htmlResponseAt(
        "https://fragment.com/?query=freshname",
        `<table><tbody>
          <tr class="tm-row-selectable js-auction-unavail">
            <td><div class="table-cell-value-row"><div class="table-cell-value tm-value">@freshname</div></div></td>
            <td><div class="tm-status-unavail">Unavailable</div><div>Not for sale</div></td>
          </tr>
        </tbody></table>`,
      ),
      async () => {
        const result = await checkFragment("freshname");
        assert.equal(result.available, true);
        assert.equal(result.confidence, "low");
        assert.match(result.detail ?? "", /collectible|not for sale/i);
      },
    );
  });

  await t.test("unrelated redirect remains unknown", async () => {
    await withFetchResponse(
      htmlResponseAt("https://fragment.com/about", "About"),
      async () => {
        const result = await checkFragment("freshname");
        assert.equal(result.available, "unknown");
        assert.match(result.detail ?? "", /неожиданную страницу/i);
      },
    );
  });
});

test("turns fetch failures into unknown", async () => {
  await withFetchResponse(
    async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    },
    async () => {
      const result = await checkFragment("abcde", { timeoutMs: 10 });
      assert.equal(result.available, "unknown");
      assert.equal(result.confidence, "low");
      assert.match(result.detail ?? "", /aborted/i);
    },
  );
});
