export interface RidgeModelJSON {
  weights: number[];
  bias: number;
  lambda: number;
  robustIterations: number;
  huberDelta: number;
}

export interface RidgeFitOptions {
  lambda?: number;
  robustIterations?: number;
  huberDelta?: number;
  /**
   * Optional observation-quality weights. Robust Huber reweighting is applied
   * on top of these weights rather than replacing them.
   */
  sampleWeights?: readonly number[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function solveSymmetricSystem(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) {
      augmented[pivot][column] = augmented[pivot][column] < 0 ? -1e-12 : 1e-12;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let cursor = column; cursor <= size; cursor++) {
      augmented[column][cursor] /= divisor;
    }
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let cursor = column; cursor <= size; cursor++) {
        augmented[row][cursor] -= factor * augmented[column][cursor];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function fitWeightedNormalEquation(
  inputs: readonly number[][],
  targets: readonly number[],
  sampleWeights: readonly number[],
  lambda: number,
): { weights: number[]; bias: number } {
  const featureCount = inputs[0].length;
  const dimension = featureCount + 1;
  const matrix = Array.from({ length: dimension }, () => new Array<number>(dimension).fill(0));
  const vector = new Array<number>(dimension).fill(0);

  for (let sample = 0; sample < inputs.length; sample++) {
    const row = inputs[sample];
    const weight = sampleWeights[sample];
    for (let left = 0; left < featureCount; left++) {
      const weightedLeft = row[left] * weight;
      vector[left] += weightedLeft * targets[sample];
      for (let right = left; right < featureCount; right++) {
        matrix[left][right] += weightedLeft * row[right];
      }
      matrix[left][featureCount] += weightedLeft;
    }
    vector[featureCount] += weight * targets[sample];
    matrix[featureCount][featureCount] += weight;
  }

  for (let left = 0; left < featureCount; left++) {
    matrix[left][left] += lambda;
    for (let right = left + 1; right < dimension; right++) {
      matrix[right][left] = matrix[left][right];
    }
  }
  const solution = solveSymmetricSystem(matrix, vector);
  if (solution.some((value) => !Number.isFinite(value))) {
    throw new Error("Ridge solver produced non-finite coefficients.");
  }
  return {
    weights: solution.slice(0, featureCount),
    bias: solution[featureCount],
  };
}

export class RidgeModel {
  readonly weights: number[];
  readonly bias: number;
  readonly lambda: number;
  readonly robustIterations: number;
  readonly huberDelta: number;

  constructor(json: RidgeModelJSON) {
    if (
      json.weights.length === 0 ||
      json.weights.some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(json.bias) ||
      !Number.isFinite(json.lambda) ||
      json.lambda <= 0
    ) {
      throw new Error("Invalid ridge model.");
    }
    this.weights = [...json.weights];
    this.bias = json.bias;
    this.lambda = json.lambda;
    this.robustIterations = json.robustIterations;
    this.huberDelta = json.huberDelta;
  }

  predict(input: readonly number[]): number[] {
    if (input.length !== this.weights.length) {
      throw new RangeError(
        `Ridge input has ${input.length} features, expected ${this.weights.length}.`,
      );
    }
    const value = this.weights.reduce(
      (sum, weight, index) => sum + weight * input[index],
      this.bias,
    );
    return [value];
  }

  toJSON(): RidgeModelJSON {
    return {
      weights: [...this.weights],
      bias: this.bias,
      lambda: this.lambda,
      robustIterations: this.robustIterations,
      huberDelta: this.huberDelta,
    };
  }

  static fit(
    inputs: readonly number[][],
    targets: readonly number[],
    options: RidgeFitOptions = {},
  ): RidgeModel {
    if (inputs.length === 0 || inputs.length !== targets.length) {
      throw new RangeError("Ridge inputs and targets must have the same non-zero length.");
    }
    const featureCount = inputs[0].length;
    if (
      featureCount === 0 ||
      inputs.some(
        (row) =>
          row.length !== featureCount || row.some((value) => !Number.isFinite(value)),
      ) ||
      targets.some((value) => !Number.isFinite(value))
    ) {
      throw new RangeError("Ridge training data must be a finite rectangular matrix.");
    }
    const lambda = options.lambda ?? 8;
    const robustIterations = options.robustIterations ?? 2;
    const huberDelta = options.huberDelta ?? 1.5;
    if (!Number.isFinite(lambda) || lambda <= 0) {
      throw new RangeError("Ridge lambda must be positive.");
    }
    if (
      !Number.isSafeInteger(robustIterations) ||
      robustIterations < 0 ||
      robustIterations > 10
    ) {
      throw new RangeError("robustIterations must be an integer from 0 to 10.");
    }
    if (!Number.isFinite(huberDelta) || huberDelta <= 0) {
      throw new RangeError("huberDelta must be positive.");
    }
    if (
      options.sampleWeights &&
      (options.sampleWeights.length !== inputs.length ||
        options.sampleWeights.some(
          (weight) => !Number.isFinite(weight) || weight <= 0,
        ))
    ) {
      throw new RangeError(
        "Ridge sampleWeights must be positive finite values matching inputs.",
      );
    }

    const baseWeights = options.sampleWeights
      ? [...options.sampleWeights]
      : new Array<number>(inputs.length).fill(1);
    let sampleWeights = [...baseWeights];
    let fitted = fitWeightedNormalEquation(inputs, targets, sampleWeights, lambda);
    for (let iteration = 0; iteration < robustIterations; iteration++) {
      const residuals = inputs.map((input, index) => {
        const prediction = fitted.weights.reduce(
          (sum, weight, feature) => sum + weight * input[feature],
          fitted.bias,
        );
        return targets[index] - prediction;
      });
      const center = median(residuals);
      const absoluteDeviations = residuals.map((value) => Math.abs(value - center));
      const scale = Math.max(1e-6, 1.4826 * median(absoluteDeviations));
      sampleWeights = absoluteDeviations.map((deviation, index) =>
        baseWeights[index] *
        (deviation <= huberDelta * scale
          ? 1
          : (huberDelta * scale) / Math.max(deviation, 1e-12)),
      );
      fitted = fitWeightedNormalEquation(inputs, targets, sampleWeights, lambda);
    }

    return new RidgeModel({
      ...fitted,
      lambda,
      robustIterations,
      huberDelta,
    });
  }

  static fromJSON(json: RidgeModelJSON): RidgeModel {
    return new RidgeModel(json);
  }
}
