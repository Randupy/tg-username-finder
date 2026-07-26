/**
 * Простой многослойный перцептрон (MLP) без внешних ML-библиотек.
 *
 * Почему не tensorflow.js/onnxruntime: это нативные зависимости с бинарными
 * биндингами, которые часто ломаются при установке на разных платформах —
 * плохой выбор для небольшого личного проекта. Датасеты здесь маленькие
 * (сотни-тысячи примеров: продажи с Fragment, избранное, посимвольные пары
 * для генератора), и такая сеть обучается за секунды на CPU без GPU и без
 * тяжёлых зависимостей.
 *
 * Поддерживает:
 * - произвольное число скрытых слоёв с ReLU;
 * - линейный выход (регрессия, например цена) или softmax (классификация,
 *   например следующий символ при генерации);
 * - обучение мини-батчами через Adam;
 * - сохранение/загрузку весов в обычный JSON.
 */

export type OutputActivation = "linear" | "softmax";

export interface MLPConfig {
  inputSize: number;
  hiddenSizes: number[];
  outputSize: number;
  outputActivation: OutputActivation;
  seed?: number;
}

interface LayerWeights {
  W: number[][]; // [outputSize][inputSize]
  b: number[];
}

export interface MLPJSON {
  config: MLPConfig;
  layers: LayerWeights[];
}

// Детерминированный ГПСЧ (mulberry32) — чтобы инициализация весов была
// воспроизводима при одном и том же seed, а не зависела от Math.random().
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function relu(x: number): number {
  return x > 0 ? x : 0;
}
function reluDeriv(x: number): number {
  return x > 0 ? 1 : 0;
}

function softmax(xs: number[]): number[] {
  const max = Math.max(...xs);
  const exps = xs.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

interface AdamState {
  mW: number[][];
  vW: number[][];
  mB: number[];
  vB: number[];
}

export class MLP {
  config: MLPConfig;
  layers: LayerWeights[];
  private adam: AdamState[] | null = null;
  private t = 0; // счётчик шагов для bias-correction в Adam

  constructor(config: MLPConfig) {
    this.config = config;
    const rand = mulberry32(config.seed ?? 42);
    const sizes = [config.inputSize, ...config.hiddenSizes, config.outputSize];
    this.layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const fanIn = sizes[l];
      const fanOut = sizes[l + 1];
      // He-инициализация — рассчитана на ReLU в скрытых слоях
      const scale = Math.sqrt(2 / fanIn);
      const W: number[][] = [];
      for (let o = 0; o < fanOut; o++) {
        const row: number[] = [];
        for (let i = 0; i < fanIn; i++) row.push((rand() * 2 - 1) * scale);
        W.push(row);
      }
      const b = new Array(fanOut).fill(0);
      this.layers.push({ W, b });
    }
  }

  /** Прямой проход с сохранением промежуточных активаций — нужно для backprop. */
  private forwardFull(input: number[]): { zs: number[][]; as: number[][] } {
    const zs: number[][] = [];
    const as: number[][] = [input];
    let a = input;
    for (let l = 0; l < this.layers.length; l++) {
      const { W, b } = this.layers[l];
      const isOutput = l === this.layers.length - 1;
      const z = W.map((row, o) => row.reduce((s, w, i) => s + w * a[i], b[o]));
      zs.push(z);
      const nextA = isOutput ? (this.config.outputActivation === "softmax" ? softmax(z) : z) : z.map(relu);
      as.push(nextA);
      a = nextA;
    }
    return { zs, as };
  }

  predict(input: number[]): number[] {
    return this.forwardFull(input).as[this.layers.length];
  }

  private ensureAdam(): AdamState[] {
    if (!this.adam) {
      this.adam = this.layers.map(({ W, b }) => ({
        mW: W.map((row) => row.map(() => 0)),
        vW: W.map((row) => row.map(() => 0)),
        mB: b.map(() => 0),
        vB: b.map(() => 0),
      }));
    }
    return this.adam;
  }

  /**
   * Один шаг обучения на мини-батче. targets — в том же формате, что и выход
   * сети (для softmax — one-hot вектор, для linear — вектор из одного числа).
   * Возвращает средний loss по батчу (MSE для linear, cross-entropy для softmax).
   */
  trainBatch(inputs: number[][], targets: number[][], learningRate = 0.01): number {
    const adam = this.ensureAdam();
    this.t++;
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    const numLayers = this.layers.length;

    const gradW: number[][][] = this.layers.map(({ W }) => W.map((row) => row.map(() => 0)));
    const gradB: number[][] = this.layers.map(({ b }) => b.map(() => 0));
    let totalLoss = 0;

    for (let s = 0; s < inputs.length; s++) {
      const { zs, as } = this.forwardFull(inputs[s]);
      const target = targets[s];
      const output = as[numLayers];

      // Для softmax+cross-entropy и для linear+MSE градиент по z на
      // выходном слое одинаково упрощается до (output - target).
      let dz = output.map((o, i) => o - target[i]);
      if (this.config.outputActivation === "softmax") {
        totalLoss += -target.reduce((s2, tv, i) => s2 + (tv > 0 ? tv * Math.log(Math.max(output[i], 1e-12)) : 0), 0);
      } else {
        totalLoss += dz.reduce((s2, d) => s2 + d * d, 0);
      }

      for (let l = numLayers - 1; l >= 0; l--) {
        const aPrev = as[l]; // вход этого слоя
        const { W } = this.layers[l];
        for (let o = 0; o < W.length; o++) {
          for (let i = 0; i < W[o].length; i++) {
            gradW[l][o][i] += dz[o] * aPrev[i];
          }
          gradB[l][o] += dz[o];
        }
        if (l > 0) {
          const prevSize = aPrev.length;
          const dPrevA = new Array(prevSize).fill(0);
          for (let o = 0; o < W.length; o++) {
            for (let i = 0; i < prevSize; i++) {
              dPrevA[i] += W[o][i] * dz[o];
            }
          }
          const zPrev = zs[l - 1];
          dz = dPrevA.map((d, i) => d * reluDeriv(zPrev[i]));
        }
      }
    }

    const batchSize = inputs.length;
    for (let l = 0; l < numLayers; l++) {
      const { W, b } = this.layers[l];
      const { mW, vW, mB, vB } = adam[l];
      for (let o = 0; o < W.length; o++) {
        for (let i = 0; i < W[o].length; i++) {
          const g = gradW[l][o][i] / batchSize;
          mW[o][i] = beta1 * mW[o][i] + (1 - beta1) * g;
          vW[o][i] = beta2 * vW[o][i] + (1 - beta2) * g * g;
          const mHat = mW[o][i] / (1 - beta1 ** this.t);
          const vHat = vW[o][i] / (1 - beta2 ** this.t);
          W[o][i] -= (learningRate * mHat) / (Math.sqrt(vHat) + eps);
        }
        const gB = gradB[l][o] / batchSize;
        mB[o] = beta1 * mB[o] + (1 - beta1) * gB;
        vB[o] = beta2 * vB[o] + (1 - beta2) * gB * gB;
        const mHatB = mB[o] / (1 - beta1 ** this.t);
        const vHatB = vB[o] / (1 - beta2 ** this.t);
        b[o] -= (learningRate * mHatB) / (Math.sqrt(vHatB) + eps);
      }
    }

    return totalLoss / batchSize;
  }

  /** Полный цикл обучения: перемешивание + разбиение на мини-батчи на каждой эпохе. */
  train(
    inputs: number[][],
    targets: number[][],
    opts: {
      epochs: number;
      batchSize?: number;
      learningRate?: number;
      onEpoch?: (epoch: number, loss: number) => void;
    },
  ): void {
    const batchSize = opts.batchSize ?? 32;
    const lr = opts.learningRate ?? 0.01;
    const n = inputs.length;
    const rand = mulberry32(12345);

    for (let epoch = 0; epoch < opts.epochs; epoch++) {
      const order = [...Array(n).keys()];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }

      let epochLoss = 0;
      let batches = 0;
      for (let start = 0; start < n; start += batchSize) {
        const idx = order.slice(start, start + batchSize);
        const batchInputs = idx.map((i) => inputs[i]);
        const batchTargets = idx.map((i) => targets[i]);
        epochLoss += this.trainBatch(batchInputs, batchTargets, lr);
        batches++;
      }
      opts.onEpoch?.(epoch, epochLoss / batches);
    }
  }

  toJSON(): MLPJSON {
    return { config: this.config, layers: this.layers };
  }

  static fromJSON(json: MLPJSON): MLP {
    const mlp = new MLP(json.config);
    mlp.layers = json.layers;
    return mlp;
  }
}
