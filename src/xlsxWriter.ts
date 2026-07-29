/**
 * Минимальный писатель .xlsx без внешних зависимостей.
 *
 * exceljs/xlsx (SheetJS) тянут по 7-9 транзитивных пакетов ради задачи,
 * которая здесь сводится к «плоская таблица, без формул, без листов
 * помногу». В духе остального проекта (см. обоснование в ml/mlp.ts —
 * маленькие датасеты не требуют тяжёлых зависимостей) собираем OOXML
 * вручную и упаковываем в ZIP без сжатия (STORED): для списка избранного
 * в десятки-сотни строк экономия от DEFLATE незначительна, а STORED
 * убирает целый класс возможных багов совместимости.
 */

export type CellValue = string | number | null | undefined;

interface ZipEntry {
  name: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; dateVal: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dateVal =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dateVal };
}

/** Собирает ZIP-архив (STORED, без сжатия) из именованных буферов. */
function buildZip(entries: ZipEntry[]): Buffer {
  const { time, dateVal } = dosDateTime(new Date());
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dateVal, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dateVal, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + entry.data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localDir = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localDir.length, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localDir, centralDir, eocd]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellXml(colIndex: number, rowIndex: number, value: CellValue, styleIndex: number): string {
  const ref = `${columnLetter(colIndex)}${rowIndex}`;
  const styleAttr = styleIndex ? ` s="${styleIndex}"` : "";
  if (value === null || value === undefined || value === "") {
    return `<c r="${ref}"${styleAttr}/>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  }
  const text = escapeXml(String(value));
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function buildSheetXml(headers: string[], rows: CellValue[][]): string {
  const lastCol = columnLetter(Math.max(headers.length - 1, 0));
  const lastRow = rows.length + 1;

  const colWidths = headers.map((header, colIndex) => {
    let max = header.length;
    for (const row of rows) {
      const value = row[colIndex];
      if (value === null || value === undefined) continue;
      max = Math.max(max, String(value).length);
    }
    return Math.min(Math.max(max + 2, 10), 60);
  });
  const colsXml = colWidths
    .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
    .join("");

  const headerRow = `<row r="1">${headers
    .map((header, colIndex) => cellXml(colIndex, 1, header, 1))
    .join("")}</row>`;

  const dataRows = rows
    .map(
      (row, rowIdx) =>
        `<row r="${rowIdx + 2}">${row.map((value, colIndex) => cellXml(colIndex, rowIdx + 2, value, 0)).join("")}</row>`,
    )
    .join("");

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${colsXml}</cols>` +
    `<sheetData>${headerRow}${dataRows}</sheetData>` +
    (rows.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : "") +
    "</worksheet>"
  );
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  "</Types>";

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  "</fonts>" +
  '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" xfId="0" applyFont="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

function buildWorkbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    "</workbook>"
  );
}

/** Строит буфер валидного .xlsx с одним листом из заголовков и строк. */
export function buildXlsx(sheetName: string, headers: string[], rows: CellValue[][]): Buffer {
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES_XML, "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS_XML, "utf-8") },
    { name: "xl/workbook.xml", data: Buffer.from(buildWorkbookXml(sheetName), "utf-8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(WORKBOOK_RELS_XML, "utf-8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES_XML, "utf-8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(buildSheetXml(headers, rows), "utf-8") },
  ];
  return buildZip(entries);
}
