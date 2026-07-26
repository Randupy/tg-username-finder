import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Минимальный .env-лоадер без зависимостей (dotenv не добавляем ради одной
 * функции). Ничего не перезаписывает, если переменная уже задана в окружении
 * (например через `node --env-file=.env` или экспорт в шелле).
 */
export function loadEnvFile(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
