import { existsSync, readFileSync } from "node:fs";
import type { SoldRecord } from "./soldHistory.js";
import { writeJsonAtomic } from "../storage/atomic.js";

const DATA_DIR = "data";
const STORE_PATH = `${DATA_DIR}/sold-history.json`;

function isSoldRecord(value: unknown): value is SoldRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SoldRecord>;
  return (
    typeof record.username === "string" &&
    /^[a-z][a-z0-9_]{3,31}$/.test(record.username.toLowerCase()) &&
    typeof record.priceTon === "number" &&
    Number.isFinite(record.priceTon) &&
    record.priceTon > 0 &&
    typeof record.scrapedAt === "string" &&
    Number.isFinite(Date.parse(record.scrapedAt))
  );
}

export function loadSoldHistory(path = STORE_PATH): SoldRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("ожидался массив");
    return parsed
      .filter(isSoldRecord)
      .map((record) => ({ ...record, username: record.username.toLowerCase() }));
  } catch {
    console.warn(`[priceData] Не удалось прочитать ${STORE_PATH}, начинаю с пустого списка.`);
    return [];
  }
}

export function saveSoldHistory(records: SoldRecord[], path = STORE_PATH): void {
  writeJsonAtomic(path, records);
}

/** Объединяет новые записи со старыми; при дубле по username оставляет более свежую (по scrapedAt). */
export function mergeSoldHistory(existing: SoldRecord[], incoming: SoldRecord[]): SoldRecord[] {
  const byUsername = new Map<string, SoldRecord>();
  for (const r of existing) byUsername.set(r.username, r);
  for (const r of incoming) {
    const prev = byUsername.get(r.username);
    if (!prev || r.scrapedAt > prev.scrapedAt) byUsername.set(r.username, r);
  }
  return [...byUsername.values()];
}
