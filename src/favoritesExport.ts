import type { FavoriteEntry } from "./types.js";
import { buildXlsx, type CellValue } from "./xlsxWriter.js";

const HEADERS = [
  "Юзернейм",
  "Источник",
  "P10, TON",
  "P50, TON",
  "P90, TON",
  "Цена, USD",
  "Цена, RUB",
  "Confidence",
  "Смысл confidence",
  "Price OOD",
  "OOD score",
  "Model disagreement, log",
  "Benchmark gate",
  "Причина gate",
  "Split",
  "Данные актуальны",
  "Effective N аналогов",
  "P(sale ≤90d)",
  "Liquidity OOD",
  "Artifact обучен",
  "Данные обучения по",
  "Добавлено",
  "Заметка",
];

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

function booleanLabel(value: boolean | undefined): string | null {
  return value === undefined ? null : value ? "да" : "нет";
}

/** Строит .xlsx со всем избранным и сохраняет признаки надёжности оценки. */
export function buildFavoritesXlsx(favorites: readonly FavoriteEntry[]): Buffer {
  const rows: CellValue[][] = favorites.map((favorite) => [
    `@${favorite.username}`,
    sourceLabel(favorite.source),
    favorite.price?.p10Ton ?? null,
    favorite.price?.ton ?? null,
    favorite.price?.p90Ton ?? null,
    favorite.price?.usd ?? null,
    favorite.price?.rub ?? null,
    favorite.price?.confidence ?? null,
    favorite.price?.confidenceDefinition ?? null,
    booleanLabel(favorite.price?.priceOutOfDistribution),
    favorite.price?.oodScore ?? null,
    favorite.price?.modelDisagreementLog ?? null,
    booleanLabel(favorite.price?.releaseGatePassed),
    favorite.price?.releaseGateReason ?? null,
    favorite.price?.splitStrategy ?? null,
    booleanLabel(favorite.price?.dataCurrent),
    favorite.price?.comparableEffectiveSampleSize ?? null,
    favorite.price?.liquidity?.saleProbability90d ?? null,
    booleanLabel(favorite.price?.liquidity?.outOfDistribution),
    favorite.price?.trainedAt ?? null,
    favorite.price?.trainedThrough ?? null,
    formatAddedAt(favorite.addedAt),
    favorite.note ?? null,
  ]);
  return buildXlsx("Избранное", HEADERS, rows);
}
