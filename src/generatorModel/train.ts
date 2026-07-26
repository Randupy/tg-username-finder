import { listFavorites } from "../favorites.js";
import { MLP } from "../ml/mlp.js";
import { loadSoldHistory } from "../priceData/store.js";
import { writeJsonAtomic } from "../storage/atomic.js";
import { CHAR_TO_IDX, CONTEXT_SIZE, VOCAB_SIZE, encodeContext } from "./vocab.js";

const MODEL_DIR = "models";
export const MODEL_PATH = `${MODEL_DIR}/generator-mlp.json`;

/**
 * Корпус для обучения генератора — юзернеймы, которые уже так или иначе
 * подтверждены как "хорошие" человеком или рынком: избранное (favorites.json)
 * и собранная история реальных продаж (data/sold-history.json, см.
 * priceData/soldHistory.ts). Это выгодно вдвойне: одни и те же данные
 * одновременно обучают и генератор, и модель цены (priceModel/train.ts).
 *
 * Без --debug-калиброванного сборщика продаж корпус может быть совсем
 * маленьким (только избранное) — тогда и генерация будет соответствующей:
 * модель уловит самые общие паттерны (длину, чередование гласных/согласных),
 * а не что-то содержательное. Это ожидаемо для небольших данных, а не баг.
 */
function buildCorpus(): string[] {
  const sold = loadSoldHistory().map((r) => r.username);
  const favs = listFavorites().map((f) => f.username);
  return [...new Set([...sold, ...favs])].filter((u) => /^[a-z][a-z0-9_]{3,31}$/.test(u.toLowerCase()));
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

export function trainGeneratorModel(opts: { epochs?: number; hiddenSizes?: number[] } = {}): void {
  const corpus = buildCorpus();
  if (corpus.length < 20) {
    console.error(
      `Слишком маленький корпус для обучения (${corpus.length} юзернеймов: избранное + собранная ` +
        "история продаж). Соберите больше данных (npm run collect-sales) или добавьте в избранное " +
        "юзернеймы, которые вам нравятся (npm run favorites -- add ...), прежде чем обучать генератор.",
    );
    process.exit(1);
  }

  const { inputs, targets } = buildTrainingPairs(corpus);
  console.log(`Корпус: ${corpus.length} юзернеймов → ${inputs.length} обучающих пар (символ за символом).`);

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
    "На маленьком корпусе не ждите содержательных неологизмов — модель в лучшем случае уловит " +
      "общие паттерны (длину, чередование гласных/согласных, частые окончания). Чем больше избранного " +
      "и собранной истории продаж, тем интереснее генерация.",
  );
}
