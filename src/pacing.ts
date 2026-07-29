/**
 * Пауза между сетевыми запросами к Telegram/Fragment. Обычный режим
 * (см. jitter в cli.ts) добавляет ±30% к фиксированной задержке — паттерн
 * пауз остаётся довольно предсказуемым. Безопасный режим вместо этого берёт
 * каждую паузу равномерно случайно из широкого диапазона и поднимает нижнюю
 * границу, если заданная пользователем задержка меньше разумного минимума —
 * так последовательность запросов меньше похожа на бота с фиксированным
 * интервалом и меньше риск словить flood-limit.
 *
 * Здесь не нужен детерминированный PRNG из random.ts (тот — для
 * воспроизводимости обучения); тут смысл ровно в обратном — непредсказуемости.
 */

export interface DelayRange {
  minMs: number;
  maxMs: number;
}

const SAFE_MODE_MIN_FLOOR_MS = 2000;
const SAFE_MODE_MAX_MULTIPLIER = 4;

/** Диапазон пауз для безопасного режима на основе введённой пользователем базовой задержки. */
export function safeModeRange(baseDelayMs: number): DelayRange {
  const minMs = Math.max(baseDelayMs, SAFE_MODE_MIN_FLOOR_MS);
  return { minMs, maxMs: minMs * SAFE_MODE_MAX_MULTIPLIER };
}

/** Равномерно случайная пауза внутри диапазона (включительно). */
export function randomDelayMs({ minMs, maxMs }: DelayRange): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.random() * (maxMs - minMs);
}
