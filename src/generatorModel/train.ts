import { MLP } from "../ml/mlp.js";
import { loadSoldHistory } from "../priceData/store.js";
import type { SoldRecord } from "../priceData/soldHistory.js";
import { DICTIONARY_WORDS } from "../priceModel/dictionaryWords.js";
import { deterministicShuffle } from "../random.js";
import { writeJsonAtomic } from "../storage/atomic.js";
import { CHAR_TO_IDX, CONTEXT_SIZE, VOCAB_SIZE, encodeContext } from "./vocab.js";

const MODEL_DIR = "models";
export const MODEL_PATH = `${MODEL_DIR}/generator-mlp.json`;

const VALID_USERNAME = /^[a-z][a-z0-9_]{3,31}$/;

const DEFAULT_DICTIONARY_SAMPLE = 1200;
const DEFAULT_DICTIONARY_SEED = 0x6e616d65; // "name" в hex, для воспроизводимости выборки

export interface GeneratorCorpusOptions {
  /**
   * Сколько слов из общего английского словаря (priceModel/dictionaryWords.ts)
   * подмешать как образец "как вообще звучит настоящее слово" — 0 отключает
   * подмес полностью. Полный словарь (~8.7k слов) утроил бы обучающий корпус
   * и время обучения; ограниченная выборка даёт заметный эффект на
   * фонотактику без непропорционального роста времени `train-generator`.
   */
  dictionarySample?: number;
  /** Seed для выборки словаря — только для тестов/воспроизводимости. */
  dictionarySeed?: number;
}

/**
 * Вес записи продажи в зависимости от её перцентиля цены среди остальных
 * собранных продаж. Нижний квартиль почти всегда шум по цене-полу рынка
 * (случайные 5-буквенные строки вроде "zzahh"/"r6363" за 10 TON — рыночный
 * минимум, а не сигнал качества имени) — отбрасываем совсем. Верхний
 * квартиль — самое представительное свидетельство того, что реально
 * покупают, поэтому повторяется чаще всего.
 */
export function weightForPricePercentile(rank: number): number {
  if (rank < 0.25) return 0;
  if (rank < 0.5) return 1;
  if (rank < 0.75) return 2;
  return 4;
}

/**
 * Без этого взвешивания сеть учится поровну на "auto" (900 000 TON) и на
 * случайном мусоре по цене пола рынка — а его в сырой истории продаж
 * примерно столько же, сколько по-настоящему ценных имён, так что
 * произносимые паттерны попросту тонут в шуме.
 */
export function priceWeightedUsernames(sold: readonly SoldRecord[]): string[] {
  if (sold.length === 0) return [];
  const sortedPrices = sold.map((r) => r.priceTon).sort((a, b) => a - b);
  const rankOf = (price: number): number => {
    let lo = 0;
    let hi = sortedPrices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedPrices[mid] < price) lo = mid + 1;
      else hi = mid;
    }
    return lo / sortedPrices.length;
  };

  const out: string[] = [];
  for (const record of sold) {
    const weight = weightForPricePercentile(rankOf(record.priceTon));
    for (let i = 0; i < weight; i++) out.push(record.username);
  }
  return out;
}

export interface CorpusBreakdown {
  corpus: string[];
  soldContributed: number;
  dictionaryContributed: number;
}

/**
 * Корпус для обучения генератора: взвешенная по цене история продаж (см.
 * priceWeightedUsernames) плюс ограниченная выборка реальных английских слов
 * из словаря priceModel/dictionaryWords.ts.
 *
 * Избранное (favorites.json) сюда сознательно не подмешивается: это ручной
 * шорт-лист конкретных имён "на посмотреть/купить", а не датасет для
 * обучения общей модели — на типичном для одного человека небольшом списке
 * (пара десятков записей) модель быстро переобучилась бы именно под них
 * вместо того, чтобы улавливать общие паттерны рынка.
 */
export function buildCorpus(opts: GeneratorCorpusOptions = {}): CorpusBreakdown {
  const sold = loadSoldHistory();
  const weightedSold = priceWeightedUsernames(sold);

  const dictionarySampleSize = opts.dictionarySample ?? DEFAULT_DICTIONARY_SAMPLE;
  const dictionarySample =
    dictionarySampleSize > 0
      ? deterministicShuffle([...DICTIONARY_WORDS], opts.dictionarySeed ?? DEFAULT_DICTIONARY_SEED).slice(
          0,
          dictionarySampleSize,
        )
      : [];

  const corpus = [...weightedSold, ...dictionarySample]
    .map((u) => u.toLowerCase())
    .filter((u) => VALID_USERNAME.test(u));

  return {
    corpus,
    soldContributed: weightedSold.length,
    dictionaryContributed: dictionarySample.length,
  };
}

function buildTrainingPairs(corpus: string[]): { inputs: number[][]; targets: number[][] } {
  const inputs: number[][] = [];
  const targets: number[][] = [];
  for (const usernameRaw of corpus) {
    const username = usernameRaw.toLowerCase();
    const chars = [...username, "<end>"];
    let context: string[] = new Array(CONTEXT_SIZE).fill("<pad>");
    for (const ch of chars) {
      inputs.push(encodeContext(context));
      const idx = CHAR_TO_IDX.get(ch) ?? CHAR_TO_IDX.get("<end>")!;
      const target = new Array(VOCAB_SIZE).fill(0);
      target[idx] = 1;
      targets.push(target);
      context = [...context.slice(1), ch];
    }
  }
  return { inputs, targets };
}

export function trainGeneratorModel(
  opts: { epochs?: number; hiddenSizes?: number[] } & GeneratorCorpusOptions = {},
): void {
  const { corpus, soldContributed, dictionaryContributed } = buildCorpus(opts);
  if (corpus.length < 20) {
    console.error(
      `Слишком маленький корпус для обучения (${corpus.length} юзернеймов: собранная история продаж + ` +
        "словарь). Соберите больше данных: npm run collect-sales, прежде чем обучать генератор.",
    );
    process.exit(1);
  }

  const { inputs, targets } = buildTrainingPairs(corpus);
  console.log(
    `Корпус: ${corpus.length} юзернеймов (продажи с учётом цены: ${soldContributed}, ` +
      `словарь: ${dictionaryContributed}) → ${inputs.length} обучающих пар (символ за символом).`,
  );

  const mlp = new MLP({
    inputSize: CONTEXT_SIZE * VOCAB_SIZE,
    hiddenSizes: opts.hiddenSizes ?? [64],
    outputSize: VOCAB_SIZE,
    outputActivation: "softmax",
  });

  const epochs = opts.epochs ?? 100;
  mlp.train(inputs, targets, {
    epochs,
    batchSize: 32,
    learningRate: 0.01,
    onEpoch: (epoch, loss) => {
      if (epoch % 10 === 0 || epoch === epochs - 1) {
        console.log(`Эпоха ${epoch}: loss=${loss.toFixed(4)}`);
      }
    },
  });

  writeJsonAtomic(MODEL_PATH, {
    ...mlp.toJSON(),
    metadata: {
      trainedOn: corpus.length,
      trainingPairs: inputs.length,
      trainedAt: new Date().toISOString(),
    },
  });
  console.log(`\nМодель генерации сохранена в ${MODEL_PATH} (обучена на ${corpus.length} примерах).`);
  console.log(
    "Продажи взвешены по цене (нижний квартиль отброшен как рыночный шум, верхний повторяется чаще), " +
      "а ограниченная выборка словаря даёт модели образец правильной фонотактики. На маленьком корпусе " +
      "не ждите содержательных неологизмов, но патерны должны быть заметно чище, чем при обучении на " +
      "сырой истории продаж без взвешивания.",
  );
}
