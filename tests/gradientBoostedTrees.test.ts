import assert from "node:assert/strict";
import test from "node:test";
import {
  GradientBoostedTrees,
  fitGradientBoostedTrees,
  type RegressionTreeNodeJSON,
} from "../src/ml/gradientBoostedTrees.js";

function regressionData(rows = 240): { inputs: number[][]; targets: number[] } {
  const inputs: number[][] = [];
  const targets: number[] = [];
  for (let index = 0; index < rows; index++) {
    const x = -2 + (4 * index) / (rows - 1);
    const nuisance = ((index * 37) % 101) / 50 - 1;
    inputs.push([x, nuisance, Math.sin(index)]);
    targets.push(x < -0.5 ? -3 : x < 0.75 ? 1.5 : 5);
  }
  return { inputs, targets };
}

function mse(actual: readonly number[], predicted: readonly number[]): number {
  return actual.reduce((sum, value, index) => {
    const residual = value - predicted[index];
    return sum + residual * residual;
  }, 0) / actual.length;
}

function assertMinLeaf(node: RegressionTreeNodeJSON, minLeaf: number): void {
  if (node.kind === "leaf") {
    assert.ok(node.samples >= minLeaf);
    return;
  }
  assertMinLeaf(node.left, minLeaf);
  assertMinLeaf(node.right, minLeaf);
}

test("squared-error boosting learns a nonlinear step function with shallow trees", () => {
  const { inputs, targets } = regressionData();
  const model = fitGradientBoostedTrees(inputs, targets, {
    trees: 80,
    learningRate: 0.1,
    maxDepth: 2,
    minLeaf: 8,
    rowSubsample: 1,
    featureSubsample: 1,
    maxBins: 48,
    seed: 7,
  });
  const predictions = model.predictBatch(inputs);

  assert.ok(mse(targets, predictions) < 0.08);
  assert.equal(model.featureCount, 3);
  assert.equal(model.treeCount, 80);
  assert.ok(model.training.trainMse < 0.08);
  for (const tree of model.toJSON().trees) assertMinLeaf(tree, 8);
});

test("row/feature subsampling is deterministic for one seed", () => {
  const { inputs, targets } = regressionData(180);
  const options = {
    trees: 24,
    learningRate: 0.08,
    maxDepth: 3,
    minLeaf: 6,
    rowSubsample: 0.7,
    featureSubsample: 0.67,
    maxBins: 32,
    seed: 12345,
  };
  const first = GradientBoostedTrees.fit(inputs, targets, options);
  const second = GradientBoostedTrees.fit(inputs, targets, options);
  const differentSeed = GradientBoostedTrees.fit(inputs, targets, {
    ...options,
    seed: 54321,
  });

  assert.deepEqual(first.toJSON(), second.toJSON());
  assert.notDeepEqual(first.toJSON().trees, differentSeed.toJSON().trees);
});

test("optional validation applies patience and restores the best tree prefix", () => {
  const inputs = Array.from({ length: 80 }, (_, index) => [index / 79]);
  const targets = new Array(80).fill(5);
  const validationInputs = Array.from({ length: 20 }, (_, index) => [index / 19]);
  const validationTargets = new Array(20).fill(5);
  const model = GradientBoostedTrees.fit(inputs, targets, {
    trees: 100,
    learningRate: 0.1,
    maxDepth: 2,
    minLeaf: 5,
    seed: 9,
    validation: {
      inputs: validationInputs,
      targets: validationTargets,
    },
    earlyStoppingRounds: 4,
  });

  assert.equal(model.treeCount, 0);
  assert.equal(model.training.attemptedTrees, 4);
  assert.equal(model.training.stoppedEarly, true);
  assert.equal(model.training.validationMse, 0);
  assert.deepEqual(model.predictBatch(validationInputs), validationTargets);
});

test("sample weights change the fitted split, leaves and weighted loss", () => {
  const inputs = [[0], [1], [2]];
  const targets = [0, 10, 0];
  const options = {
    trees: 1,
    learningRate: 1,
    maxDepth: 1,
    minLeaf: 1,
    rowSubsample: 1,
    featureSubsample: 1,
    maxBins: 8,
    seed: 3,
  } as const;
  const unweighted = GradientBoostedTrees.fit(inputs, targets, options);
  const weighted = GradientBoostedTrees.fit(inputs, targets, {
    ...options,
    sampleWeights: [1, 1, 100],
  });

  assert.ok(Math.abs(unweighted.baseValue - 10 / 3) < 1e-12);
  assert.ok(Math.abs(weighted.baseValue - 10 / 102) < 1e-12);
  assert.deepEqual(unweighted.predictBatch(inputs), [0, 5, 5]);
  assert.deepEqual(weighted.predictBatch(inputs), [5, 5, 0]);
  assert.notDeepEqual(weighted.toJSON().trees, unweighted.toJSON().trees);
  assert.ok(weighted.training.trainMse < 0.5);
  assert.equal("sampleWeights" in weighted.toJSON(), false);
  assert.equal("sampleWeights" in weighted.toJSON().config, false);
});

test("validation sample weights change reported validation MSE", () => {
  const inputs = [[0], [1], [2]];
  const targets = [0, 10, 0];
  const validation = { inputs, targets: [0, 5, 10] };
  const options = {
    trees: 1,
    learningRate: 1,
    maxDepth: 1,
    minLeaf: 1,
    rowSubsample: 1,
    featureSubsample: 1,
    maxBins: 8,
    validation,
    earlyStoppingRounds: 0,
  } as const;
  const unweighted = GradientBoostedTrees.fit(inputs, targets, options);
  const weighted = GradientBoostedTrees.fit(inputs, targets, {
    ...options,
    validation: { ...validation, sampleWeights: [1, 1, 100] },
  });

  assert.ok(Math.abs(unweighted.training.validationMse! - 25 / 3) < 1e-12);
  assert.ok(Math.abs(weighted.training.validationMse! - 2_500 / 102) < 1e-12);
});

test("JSON round-trip preserves predictions and rejects malformed trees", () => {
  const { inputs, targets } = regressionData(120);
  const model = GradientBoostedTrees.fit(inputs, targets, {
    trees: 18,
    maxDepth: 2,
    minLeaf: 5,
    seed: 88,
  });
  const json = model.toJSON();
  const restored = GradientBoostedTrees.fromJSON(
    JSON.parse(JSON.stringify(json)),
  );
  assert.deepEqual(restored.toJSON(), json);
  assert.deepEqual(restored.predictBatch(inputs), model.predictBatch(inputs));

  const malformed = JSON.parse(JSON.stringify(json)) as any;
  const split = malformed.trees.find(
    (tree: RegressionTreeNodeJSON) => tree.kind === "split",
  );
  assert.ok(split);
  split.featureIndex = malformed.featureCount;
  assert.throws(
    () => GradientBoostedTrees.fromJSON(malformed),
    /featureIndex/,
  );

  const nonFinite = JSON.parse(JSON.stringify(json)) as any;
  nonFinite.baseValue = Number.NaN;
  assert.throws(
    () => GradientBoostedTrees.fromJSON(nonFinite),
    /baseValue/,
  );
});

test("fit rejects non-finite/ragged data and invalid early-stopping usage", () => {
  assert.throws(
    () => GradientBoostedTrees.fit([[1], [Number.NaN]], [1, 2]),
    /finite rectangular row/,
  );
  assert.throws(
    () => GradientBoostedTrees.fit([[1], [2, 3]], [1, 2]),
    /finite rectangular row/,
  );
  assert.throws(
    () =>
      GradientBoostedTrees.fit([[1], [2]], [1, 2], {
        earlyStoppingRounds: 3,
      }),
    /requires a validation set/,
  );
  assert.throws(
    () =>
      GradientBoostedTrees.fit([[1], [2]], [1, 2], {
        validation: { inputs: [[1, 2]], targets: [1] },
      }),
    /validation.inputs/,
  );
  assert.throws(
    () =>
      GradientBoostedTrees.fit([[1], [2]], [1, 2], {
        sampleWeights: [1],
      }),
    /sampleWeights.*positive finite value per row/,
  );
  for (const invalidWeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        GradientBoostedTrees.fit([[1], [2]], [1, 2], {
          sampleWeights: [1, invalidWeight],
        }),
      /sampleWeights.*positive finite value per row/,
    );
  }
  assert.throws(
    () =>
      GradientBoostedTrees.fit([[1], [2]], [1, 2], {
        validation: {
          inputs: [[1], [2]],
          targets: [1, 2],
          sampleWeights: [1, Number.POSITIVE_INFINITY],
        },
      }),
    /validation\.sampleWeights.*positive finite value per row/,
  );
});
