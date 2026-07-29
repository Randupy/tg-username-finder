import type { FavoriteEntry } from "./types.js";
import { buildXlsx, type CellValue } from "./xlsxWriter.js";

const HEADERS = ["Юзернейм", "Источник", "Цена, TON", "Цена, USD", "Цена, RUB", "Добавлено", "Заметка"];

function sourceLabel(source: FavoriteEntry["source"]): string {
  return source === "telegram" ? "Telegram" : "Fragment";
}

function formatAddedAt(addedAt: string): string {
  const parsed = new Date(addedAt);
  if (Number.isNaN(parsed.getTime())) return addedAt;
  return parsed.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Строит .xlsx со всем избранным, независимо от текущего фильтра в интерфейсе. */
export function buildFavoritesXlsx(favorites: readonly FavoriteEntry[]): Buffer {
  const rows: CellValue[][] = favorites.map((favorite) => [
    `@${favorite.username}`,
    sourceLabel(favorite.source),
    favorite.price?.ton ?? null,
    favorite.price?.usd ?? null,
    favorite.price?.rub ?? null,
    formatAddedAt(favorite.addedAt),
    favorite.note ?? null,
  ]);
  return buildXlsx("Избранное", HEADERS, rows);
}
