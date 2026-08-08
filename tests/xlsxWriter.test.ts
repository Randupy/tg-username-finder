import assert from "node:assert/strict";
import test from "node:test";

import { buildXlsx } from "../src/xlsxWriter.js";
import { buildFavoritesXlsx } from "../src/favoritesExport.js";
import type { FavoriteEntry } from "../src/types.js";

/**
 * buildXlsx всегда пишет записи как STORED (без сжатия), поэтому каждую
 * можно прочитать без библиотеки для ZIP — локальный заголовок содержит имя
 * и точный размер несжатых данных.
 */
function readStoredZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break; // конец локальных записей, дальше central directory
    const method = buffer.readUInt16LE(offset + 8);
    assert.equal(method, 0, "writer должен использовать только STORED (method 0)");
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf-8");
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

test("buildXlsx produces a valid ZIP/OOXML structure with expected parts", () => {
  const buf = buildXlsx("Лист", ["Колонка А", "Колонка Б"], [
    ["значение 1", 42],
    [null, undefined],
  ]);

  assert.deepEqual(buf.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const entries = readStoredZipEntries(buf);
  for (const expected of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
  ]) {
    assert.ok(entries.has(expected), `отсутствует часть архива: ${expected}`);
  }

  const sheetXml = entries.get("xl/worksheets/sheet1.xml")!.toString("utf-8");
  assert.match(sheetXml, /<worksheet xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main">/);
  // Заголовок — жирным стилем (s="1"), обычные ячейки — без атрибута стиля.
  assert.match(sheetXml, /<c r="A1" s="1" t="inlineStr">/);
  assert.match(sheetXml, /<c r="A2" t="inlineStr">/);
  // Число записано как есть, без t="inlineStr".
  assert.match(sheetXml, /<c r="B2"><v>42<\/v><\/c>/);
  // null/undefined -> пустая ячейка без <v>/<is>.
  assert.match(sheetXml, /<c r="A3"\/>/);
  assert.match(sheetXml, /<c r="B3"\/>/);

  const workbookXml = entries.get("xl/workbook.xml")!.toString("utf-8");
  assert.match(workbookXml, /name="Лист"/);
});

test("buildXlsx escapes XML special characters in cell text", () => {
  const buf = buildXlsx("Sheet1", ["h"], [[`<script>&"'`]]);
  const entries = readStoredZipEntries(buf);
  const sheetXml = entries.get("xl/worksheets/sheet1.xml")!.toString("utf-8");
  assert.ok(sheetXml.includes("&lt;script&gt;&amp;&quot;&apos;"));
  assert.ok(!sheetXml.includes("<script>"));
});

test("buildXlsx handles an empty row set (header-only workbook)", () => {
  const buf = buildXlsx("Sheet1", ["A", "B"], []);
  const entries = readStoredZipEntries(buf);
  const sheetXml = entries.get("xl/worksheets/sheet1.xml")!.toString("utf-8");
  assert.match(sheetXml, /<dimension ref="A1:B1"\/>/);
  assert.ok(!sheetXml.includes("<autoFilter"), "автофильтр не нужен, если нет строк данных");
});

test("buildFavoritesXlsx maps favorite fields into the expected columns", () => {
  const favorites: FavoriteEntry[] = [
    {
      username: "coolvibe",
      source: "telegram",
      note: "звучное, короткое",
      price: {
        ton: 125.5,
        usd: 380,
        rub: 29_000,
        p10Ton: 80,
        p90Ton: 240,
        confidence: "medium",
        confidenceDefinition: "probability-within-2x",
        priceOutOfDistribution: false,
        oodScore: 0.2,
        modelDisagreementLog: 0.17,
        releaseGatePassed: false,
        releaseGateReason: "non-temporal-evaluation",
        splitStrategy: "group-random",
        dataCurrent: true,
        comparableEffectiveSampleSize: 7.5,
        trainedAt: "2026-07-26T00:00:00.000Z",
        trainedThrough: "2026-07-25T00:00:00.000Z",
        liquidity: { saleProbability90d: 0.4, outOfDistribution: true },
      },
      addedAt: "2026-07-27T12:00:00.000Z",
    },
    {
      username: "topauto",
      source: "fragment",
      addedAt: "2026-07-26T00:00:00.000Z",
    },
  ];

  const buf = buildFavoritesXlsx(favorites);
  const entries = readStoredZipEntries(buf);
  const sheetXml = entries.get("xl/worksheets/sheet1.xml")!.toString("utf-8");

  assert.ok(sheetXml.includes("Юзернейм"));
  assert.ok(sheetXml.includes("@coolvibe"));
  assert.ok(sheetXml.includes("Telegram"));
  assert.ok(sheetXml.includes("125.5"));
  assert.ok(sheetXml.includes("non-temporal-evaluation"));
  assert.ok(sheetXml.includes("probability-within-2x"));
  assert.ok(sheetXml.includes("0.17"));
  assert.ok(sheetXml.includes("2026-07-26T00:00:00.000Z"));
  assert.ok(sheetXml.includes("звучное, короткое"));
  assert.ok(sheetXml.includes("@topauto"));
  assert.ok(sheetXml.includes("Fragment"));
  // Без заметки/цены — пустая ячейка, а не "undefined"/"null" текстом.
  assert.ok(!sheetXml.includes(">undefined<"));
  assert.ok(!sheetXml.includes(">null<"));
});

test("buildFavoritesXlsx works with an empty favorites list", () => {
  const buf = buildFavoritesXlsx([]);
  const entries = readStoredZipEntries(buf);
  const sheetXml = entries.get("xl/worksheets/sheet1.xml")!.toString("utf-8");
  assert.match(sheetXml, /<dimension ref="A1:W1"\/>/);
});
