/**
 * Посимвольная модель генерации — это, по сути, простая нейросетевая языковая
 * модель (в духе Bengio et al., 2003): по последним CONTEXT_SIZE символам
 * предсказываем распределение вероятностей следующего символа. Без
 * эмбеддингов — каждый символ контекста представлен one-hot вектором,
 * все вместе конкатенированы на входе MLP. Для словаря из ~39 символов и
 * контекста в 4 символа это компактно и обучается быстро.
 */

export const CONTEXT_SIZE = 4;

export const VOCAB = ["<pad>", "<end>", ..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")];
export const CHAR_TO_IDX = new Map(VOCAB.map((c, i) => [c, i]));
export const VOCAB_SIZE = VOCAB.length;

export function oneHot(idx: number): number[] {
  const v = new Array(VOCAB_SIZE).fill(0);
  v[idx] = 1;
  return v;
}

/** context — массив длиной CONTEXT_SIZE из символов словаря (включая "<pad>"). */
export function encodeContext(context: string[]): number[] {
  return context.flatMap((c) => oneHot(CHAR_TO_IDX.get(c) ?? 0));
}
