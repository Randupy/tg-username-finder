import { MLP, type MLPJSON } from "../ml/mlp.js";
import { loadSoldHistory } from "../priceData/store.js";
import type { SoldRecord } from "../priceData/soldHistory.js";
import { deterministicShuffle as sharedDeterministicShuffle } from "../random.js";
import { writeJsonAtomic } from "../storage/atomic.js";
import { extractFeatures, FEATURE_NAMES } from "./features.js";

const MODEL_DIR = "models";
const DEFAULT_SPLIT_SEED = 0x51f15e;
export const MODEL_PATH = `${MODEL_DIR}/price-mlp.json`;

export interface PriceModelMetrics {
  /** Zero-based epoch whose checkpoint is stored in `mlp`. */
  bestEpoch: number;
  /** MSE in normalized log-price space at the stored checkpoint. */
  trainMse: number;
  /** MSE in normalized log-price space at the stored checkpoint. */
  validationMse: number;
  trainingSize: number;
  validationSize: number;
}

export interface PriceModelFile {
  mlp: MLPJSON;
  // Нормализация признаков: (x - mean) / std по каждому столбцу.
  featureMean: number[];
  featureStd: number[];
  // Модель предсказывает log(price + 1) — цены на ники сильно скошены
  // (единицы vs тысячи TON), логарифм делает распределение управляемым.
  targetMean: number;
  targetStd: number;
  trainedOn: number;
  trainedAt: string;
  /**
   * Optional so model files produced by older versions remain assignable and
   * readable by the current predictor.
   */
  metrics?: PriceModelMetrics;
}

export interface PriceTrainingOptions {
  epochs?: number;
  hiddenSizes?: number[];
  valFraction?: number;
  /** Controls the pre-split shuffle and network initialization. */
  seed?: number;
  batchSize?: number;
  learningRate?: number;
}

export interface PreparedPriceTrainingData {
  trainInputs: number[][];
  trainTargets: number[][];
  validationInputs: number[][];
  validationTargets: number[][];
  trainingRecords: SoldRecord[];
  validationRecords: SoldRecord[];
  featureMean: number[];
  featureStd: number[];
  targetMean: number;
  targetStd: number;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[], m: number): number {
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  const result = Math.sqrt(v);
  // Floating-point noise can make a constant decimal column look as if it had
  // an extremely small non-zero variance, magnifying noise during normalization.
  return result > 1e-12 ? result : 1;
}

/** Returns a shuffled copy; the caller's history remains untouched. */
export function deterministicShuffle<T>(values: readonly T[], seed = DEFAULT_SPLIT_SEED): T[] {
  return sharedDeterministicShuffle(values, seed);
}

/**
 * Split first, then derive every normalization statistic exclusively from the
 * training partition. Validation values never influence the transform.
 */
export function preparePriceTrainingData(
  history: readonly SoldRecord[],
  valFraction = 0.15,
  seed = DEFAULT_SPLIT_SEED,
): PreparedPriceTrainingData {
  if (history.length < 2) {
    throw new RangeError("Для train/validation split нужны хотя бы две записи.");
  }
  if (!Number.isFinite(valFraction) || valFraction <= 0 || valFraction >= 1) {
    throw new RangeError("valFraction должен быть больше 0 и меньше 1.");
  }

  const shuffled = deterministicShuffle(history, seed);
  const validationSize = Math.min(
    shuffled.length - 1,
    Math.max(1, Math.floor(shuffled.length * valFraction)),
  );
  const validationRecords = shuffled.slice(0, validationSize);
  const trainingRecords = shuffled.slice(validationSize);

  const trainFeatureMatrix = trainingRecords.map((record) => extractFeatures(record.username));
  const trainLogPrices = trainingRecords.map((record) => Math.log(record.priceTon + 1));
  const validationFeatureMatrix = validationRecords.map((record) => extractFeatures(record.username));
  const validationLogPrices = validationRecords.map((record) => Math.log(record.priceTon + 1));

  const featureMean: number[] = [];
  const featureStd: number[] = [];
  for (let feature = 0; feature < FEATURE_NAMES.length; feature++) {
    const column = trainFeatureMatrix.map((row) => row[feature]);
    const columnMean = mean(column);
    featureMean.push(columnMean);
    featureStd.push(std(column, columnMean));
  }
  const targetMean = mean(trainLogPrices);
  const targetStd = std(trainLogPrices, targetMean);

  const normalizeInputs = (matrix: number[][]): number[][] =>
    matrix.map((row) => row.map((value, i) => (value - featureMean[i]) / featureStd[i]));
  const normalizeTargets = (values: number[]): number[][] =>
    values.map((value) => [(value - targetMean) / targetStd]);

  return {
    trainInputs: normalizeInputs(trainFeatureMatrix),
    trainTargets: normalizeTargets(trainLogPrices),
    validationInputs: normalizeInputs(validationFeatureMatrix),
    validationTargets: normalizeTargets(validationLogPrices),
    trainingRecords,
    validationRecords,
    featureMean,
    featureStd,
    targetMean,
    targetStd,
  };
}

function mse(mlp: MLP, inputs: number[][], targets: number[][]): number {
  return (
    inputs.reduce((sum, input, index) => {
      const delta = mlp.predict(input)[0] - targets[index][0];
      return sum + delta * delta;
    }, 0) / inputs.length
  );
}

function cloneMlpJson(json: MLPJSON): MLPJSON {
  return {
    config: {
      ...json.config,
      hiddenSizes: [...json.config.hiddenSizes],
    },
    layers: json.layers.map((layer) => ({
      W: layer.W.map((row) => [...row]),
      b: [...layer.b],
    })),
  };
}

/**
 * Pure in-memory training entry point used by trainPriceModel and regression
 * tests. The returned network is the best validation checkpoint, not merely
 * the weights from the final epoch.
 */
export function fitPriceModel(
  history: readonly SoldRecord[],
  opts: PriceTrainingOptions = {},
): PriceModelFile {
  const epochs = opts.epochs ?? 200;
  if (!Number.isSafeInteger(epochs) || epochs <= 0) {
    throw new RangeError("epochs должен быть положительным целым числом.");
  }
  const batchSize = opts.batchSize ?? 16;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize должен быть положительным целым числом.");
  }
  const learningRate = opts.learningRate ?? 0.01;
  if (!Number.isFinite(learningRate) || learningRate <= 0) {
    throw new RangeError("learningRate должен быть положительным числом.");
  }

  const seed = opts.seed ?? DEFAULT_SPLIT_SEED;
  const data = preparePriceTrainingData(history, opts.valFraction ?? 0.15, seed);
  const mlp = new MLP({
    inputSize: FEATURE_NAMES.length,
    hiddenSizes: opts.hiddenSizes ?? [16, 8],
    outputSize: 1,
    outputActivation: "linear",
    seed,
  });

  let bestCheckpoint: MLPJSON | null = null;
  let bestEpoch = -1;
  let bestTrainMse = Number.POSITIVE_INFINITY;
  let bestValidationMse = Number.POSITIVE_INFINITY;

  mlp.train(data.trainInputs, data.trainTargets, {
    epochs,
    batchSize,
    learningRate,
    onEpoch: (epoch) => {
      const trainMse = mse(mlp, data.trainInputs, data.trainTargets);
      const validationMse = mse(mlp, data.validationInputs, data.validationTargets);
      if (!Number.isFinite(trainMse) || !Number.isFinite(validationMse)) {
        throw new Error("Обучение стало численно нестабильным: MSE не является конечным числом.");
      }
      if (validationMse < bestValidationMse) {
        bestCheckpoint = cloneMlpJson(mlp.toJSON());
        bestEpoch = epoch;
        bestTrainMse = trainMse;
        bestValidationMse = validationMse;
      }
      if (epoch % 20 === 0 || epoch === epochs - 1) {
        console.log(
          `Эпоха ${epoch}: train MSE=${trainMse.toFixed(4)}, val MSE=${validationMse.toFixed(4)}`,
        );
      }
    },
  });

  if (!bestCheckpoint || bestEpoch < 0) {
    throw new Error("Не удалось получить валидный checkpoint модели.");
  }

  return {
    mlp: bestCheckpoint,
    featureMean: data.featureMean,
    featureStd: data.featureStd,
    targetMean: data.targetMean,
    targetStd: data.targetStd,
    trainedOn: history.length,
    trainedAt: new Date().toISOString(),
    metrics: {
      bestEpoch,
      trainMse: bestTrainMse,
      validationMse: bestValidationMse,
      trainingSize: data.trainingRecords.length,
      validationSize: data.validationRecords.length,
    },
  };
}

export function trainPriceModel(opts: PriceTrainingOptions = {}): void {
  const history = loadSoldHistory();
  if (history.length < 30) {
    console.error(
      `Слишком мало данных для обучения (${history.length} записей в data/sold-history.json).\n` +
        "Нужно минимум несколько десятков реальных продаж — соберите их через " +
        "`npm run collect-sales`, прежде чем обучать модель. Меньше данных — не ошибка, " +
        "но результат будет практически случайным.",
    );
    process.exit(1);
  }

  const modelFile = fitPriceModel(history, opts);
  writeJsonAtomic(MODEL_PATH, modelFile);
  console.log(
    `\nМодель сохранена в ${MODEL_PATH} (обучена на ${history.length} примерах, ` +
      `из них ${modelFile.metrics?.validationSize ?? 0} — валидация; ` +
      `лучший checkpoint — эпоха ${modelFile.metrics?.bestEpoch ?? "?"}).`,
  );
  console.log(
    "На небольшом датасете не ждите высокой точности — ориентируйтесь на порядок величины, " +
      "а не на точную цифру. Чем больше реальных продаж соберёте, тем осмысленнее прогноз.",
  );
}
