/**
 * Shared deterministic PRNG utilities (mulberry32), used by both the price
 * trainer (train/validation split) and the generator trainer (dictionary
 * sampling) so the two don't drift into subtly different shuffle behavior
 * as either one changes independently.
 */

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns a shuffled copy; the caller's array remains untouched. */
export function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
  const shuffled = [...values];
  const random = mulberry32(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
