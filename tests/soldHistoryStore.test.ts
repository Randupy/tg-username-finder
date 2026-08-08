import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSoldEventId,
  type SoldRecord,
} from "../src/priceData/soldHistory.js";
import {
  loadSoldHistory,
  mergeSoldHistory,
  saveSoldHistory,
  SoldHistoryConflictError,
  SoldHistoryValidationError,
  SoldHistoryWarehouseError,
} from "../src/priceData/store.js";

const SCRAPED_AT = "2026-07-31T00:00:00.000Z";

function event(
  username: string,
  priceTon: number,
  saleAt: string,
  scrapedAt = SCRAPED_AT,
): SoldRecord {
  const record: SoldRecord = {
    username,
    priceTon,
    scrapedAt,
    saleAt,
    source: "fragment",
    view: "ending",
    confidence: "high",
    provenance: {
      parser: "fragment-sold-table",
      assetUrl: `https://fragment.com/username/${username}`,
      page: 1,
      rowIndex: 0,
    },
  };
  record.eventId = buildSoldEventId(record);
  return record;
}

test("loads legacy three-field history and enriched events together", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-sold-store-"));
  const path = join(directory, "history.json");
  try {
    writeFileSync(
      path,
      JSON.stringify([
        {
          username: "Legacy_Name",
          priceTon: 10,
          scrapedAt: "2026-07-30T12:00:00+00:00",
        },
        {
          ...event("alpha", 100, "2025-01-02T03:04:05+00:00"),
          eventId: undefined,
        },
      ]),
      "utf8",
    );

    const loaded = loadSoldHistory(path);
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded[0], {
      username: "legacy_name",
      priceTon: 10,
      scrapedAt: "2026-07-30T12:00:00.000Z",
    });
    assert.equal(loaded[1].saleAt, "2025-01-02T03:04:05.000Z");
    assert.equal(
      loaded[1].provenance?.assetUrl,
      "https://fragment.com/username/alpha",
    );
    assert.match(loaded[1].eventId ?? "", /^fragment:[a-f0-9]{32}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy snapshots without event ids still keep the newest observation", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-sold-legacy-refresh-"));
  const path = join(directory, "history.json");
  try {
    writeFileSync(
      path,
      JSON.stringify([
        {
          username: "legacy_name",
          priceTon: 10,
          scrapedAt: "2026-07-30T00:00:00Z",
        },
        {
          username: "legacy_name",
          priceTon: 12,
          scrapedAt: "2026-07-31T00:00:00Z",
        },
      ]),
      "utf8",
    );

    const loaded = loadSoldHistory(path);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].priceTon, 12);
    assert.equal(loaded[0].scrapedAt, "2026-07-31T00:00:00.000Z");
    assert.equal(loaded[0].saleAt, undefined);
    assert.equal(loaded[0].eventId, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observation-only legacy ids are not trusted as exact event identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-sold-observed-only-"));
  const path = join(directory, "history.json");
  try {
    writeFileSync(
      path,
      JSON.stringify([
        {
          username: "legacy_name",
          priceTon: 10,
          scrapedAt: SCRAPED_AT,
          confidence: "high",
          eventId: "fragment:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ]),
      "utf8",
    );

    const loaded = loadSoldHistory(path);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].saleAt, undefined);
    assert.equal(loaded[0].eventId, undefined);
    assert.equal(loaded[0].confidence, "low");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit sold event id must match its canonical exact identity", () => {
  const original = event("alpha", 100, "2025-01-01T00:00:00Z");
  const forged: SoldRecord = {
    ...original,
    eventId: "fragment:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  assert.throws(
    () => mergeSoldHistory([], [forged]),
    /eventId does not match canonical sale identity/,
  );
});

test("merge preserves repeated sales of the same username", () => {
  const first = event("alpha", 100, "2024-01-01T00:00:00Z");
  const second = event("alpha", 250, "2025-01-01T00:00:00Z");

  const merged = mergeSoldHistory([first], [second]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((record) => record.priceTon), [100, 250]);
  assert.notEqual(merged[0].eventId, merged[1].eventId);
});

test("merge refreshes one event without changing immutable sale evidence", () => {
  const original = event(
    "alpha",
    100,
    "2025-01-01T00:00:00Z",
    "2026-07-30T00:00:00Z",
  );
  const refreshed: SoldRecord = {
    ...original,
    scrapedAt: "2026-07-31T00:00:00Z",
    view: "price_desc",
    provenance: { parser: "fragment-sold-table", page: 2, rowIndex: 7 },
  };

  const merged = mergeSoldHistory([original], [refreshed]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].priceTon, 100);
  assert.equal(merged[0].scrapedAt, "2026-07-31T00:00:00.000Z");
  assert.equal(merged[0].view, "price_desc");
});

test("merge and save reject conflicting immutable evidence for one eventId", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-sold-conflict-"));
  const path = join(directory, "history.json");
  try {
    const original = event("alpha", 100, "2025-01-01T00:00:00Z");
    const conflicting: SoldRecord = {
      ...original,
      priceTon: 125,
      scrapedAt: "2026-08-01T00:00:00Z",
    };

    assert.throws(
      () => mergeSoldHistory([original], [conflicting]),
      SoldHistoryConflictError,
    );
    assert.throws(
      () => saveSoldHistory([original, conflicting], path),
      SoldHistoryConflictError,
    );
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("load rejects a conflicting persisted duplicate instead of overwriting it", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-sold-load-conflict-"));
  const path = join(directory, "history.json");
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const original = event("alpha", 100, "2025-01-01T00:00:00Z");
    const originalBytes = JSON.stringify([
      original,
      {
        ...original,
        priceTon: 125,
        scrapedAt: "2026-08-01T00:00:00Z",
      },
    ]);
    writeFileSync(path, originalBytes, "utf8");

    assert.throws(
      () => loadSoldHistory(path),
      (error: unknown) => {
        assert.ok(error instanceof SoldHistoryWarehouseError);
        assert.match(error.message, /refusing partial load/);
        assert.match(error.message, /Conflicting priceTon/);
        return true;
      },
    );
    assert.throws(
      () => saveSoldHistory([event("bravo", 50, "2025-02-01T00:00:00Z")], path),
      SoldHistoryWarehouseError,
    );
    assert.equal(readFileSync(path, "utf8"), originalBytes);
  } finally {
    console.warn = originalWarn;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed JSON or envelope cannot become an empty writable history", async (t) => {
  for (const [name, originalBytes] of [
    ["malformed JSON", '[{"username":'],
    ["invalid envelope", JSON.stringify({ records: [] })],
  ] as const) {
    await t.test(name, () => {
      const directory = mkdtempSync(join(tmpdir(), "tg-sold-malformed-"));
      const path = join(directory, "history.json");
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        writeFileSync(path, originalBytes, "utf8");
        assert.throws(
          () => loadSoldHistory(path),
          SoldHistoryWarehouseError,
        );
        assert.throws(
          () =>
            saveSoldHistory(
              [event("alpha", 10, "2025-01-01T00:00:00Z")],
              path,
            ),
          SoldHistoryWarehouseError,
        );
        assert.equal(readFileSync(path, "utf8"), originalBytes);
      } finally {
        console.warn = originalWarn;
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("invalid explicit saleAt is rejected instead of becoming a legacy record", () => {
  const directory = mkdtempSync(join(tmpdir(), "tg-sold-invalid-time-"));
  const loadPath = join(directory, "history.json");
  const savePath = join(directory, "saved.json");
  const malformed = {
    username: "broken_time",
    priceTon: 10,
    scrapedAt: SCRAPED_AT,
    saleAt: "not-a-date",
  } as SoldRecord;
  const impossible = {
    username: "future_sale",
    priceTon: 10,
    scrapedAt: SCRAPED_AT,
    saleAt: "2026-08-01T00:00:00Z",
  } as SoldRecord;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const originalBytes = JSON.stringify([
      { username: "legacy_name", priceTon: 5, scrapedAt: SCRAPED_AT },
      malformed,
    ]);
    writeFileSync(loadPath, originalBytes, "utf8");

    assert.throws(
      () => loadSoldHistory(loadPath),
      (error: unknown) => {
        assert.ok(error instanceof SoldHistoryWarehouseError);
        assert.match(error.message, /refusing partial load/);
        assert.match(error.message, /saleAt must be a valid timestamp/);
        return true;
      },
    );
    assert.throws(
      () => saveSoldHistory([event("alpha", 10, "2025-01-01T00:00:00Z")], loadPath),
      SoldHistoryWarehouseError,
    );
    assert.equal(readFileSync(loadPath, "utf8"), originalBytes);
    assert.throws(
      () => mergeSoldHistory([], [malformed]),
      SoldHistoryValidationError,
    );
    assert.throws(
      () => saveSoldHistory([malformed], savePath),
      SoldHistoryValidationError,
    );
    assert.throws(
      () => mergeSoldHistory([], [impossible]),
      /saleAt cannot be later than scrapedAt/,
    );
    assert.equal(existsSync(savePath), false);
  } finally {
    console.warn = originalWarn;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an enriched event upgrades an equivalent legacy snapshot in place", () => {
  const legacy: SoldRecord = {
    username: "alpha",
    priceTon: 100,
    scrapedAt: "2026-07-30T00:00:00Z",
  };
  const enriched = event(
    "alpha",
    100,
    "2025-01-01T00:00:00Z",
    "2026-07-31T00:00:00Z",
  );

  const merged = mergeSoldHistory([legacy], [enriched]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].eventId, enriched.eventId);
  assert.equal(merged[0].saleAt, "2025-01-01T00:00:00.000Z");
});

test("a different enriched sale does not erase an uncertain legacy event", () => {
  const legacy: SoldRecord = {
    username: "alpha",
    priceTon: 100,
    scrapedAt: "2026-07-30T00:00:00Z",
  };
  const resale = event(
    "alpha",
    250,
    "2025-01-01T00:00:00Z",
    "2026-07-31T00:00:00Z",
  );

  const merged = mergeSoldHistory([legacy], [resale]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((record) => record.priceTon), [100, 250]);
});
