import { existsSync, readFileSync } from "node:fs";
import { isValidTelegramUsername } from "../generator.js";
import { MLP, type MLPJSON } from "../ml/mlp.js";
import type { GeneratedCandidate } from "../types.js";
import { MODEL_PATH } from "./train.js";
import { CONTEXT_SIZE, VOCAB, encodeContext } from "./vocab.js";

let cachedMlp: MLP | null = null;

export function generatorModelExists(): boolean {
  return existsSync(MODEL_PATH);
}

function loadModel(): MLP {
  if (cachedMlp) return cachedMlp;
  if (!existsSync(MODEL_PATH)) {
    throw new Error(`Модель генерации не найдена (${MODEL_PATH}). Сначала обучите её: npm run train-generator.`);
  }
  const json: MLPJSON = JSON.parse(readFileSync(MODEL_PATH, "utf-8"));
  cachedMlp = MLP.fromJSON(json);
  return cachedMlp;
}

/** Сэмплирование индекса по распределению вероятностей с температурой (0 = argmax, чем выше — тем случайнее). */
function sampleFromDistribution(probs: number[], temperature: number, rand: () => number): number {
  if (temperature <= 0) {
    return probs.indexOf(Math.max(...probs));
  }
  const logits = probs.map((p) => Math.log(Math.max(p, 1e-12)) / temperature);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const adjusted = exps.map((e) => e / sum);

  const r = rand();
  let cum = 0;
  for (let i = 0; i < adjusted.length; i++) {
    cum += adjusted[i];
    if (r <= cum) return i;
  }
  return adjusted.length - 1;
}

function generateOne(mlp: MLP, temperature: number, maxLen: number): string | null {
  let context: string[] = new Array(CONTEXT_SIZE).fill("<pad>");
  let result = "";
  for (let step = 0; step < maxLen; step++) {
    const probs = mlp.predict(encodeContext(context));
    const idx = sampleFromDistribution(probs, temperature, Math.random);
    const ch = VOCAB[idx];
    if (ch === "<end>") break;
    if (ch === "<pad>") continue; // не должно предсказываться на практике, но на всякий случай пропускаем
    result += ch;
    context = [...context.slice(1), ch];
  }
  return result.length > 0 ? result : null;
}

export function generateWithModel(
  count: number,
  minLen: number,
  maxLen: number,
  temperature = 0.8,
): GeneratedCandidate[] {
  const mlp = loadModel();
  const results = new Set<string>();
  let guard = 0;

  while (results.size < count && guard < count * 100) {
    guard++;
    const candidate = generateOne(mlp, temperature, maxLen + 2);
    if (!candidate) continue;
    if (candidate.length < minLen || candidate.length > maxLen) continue;
    if (!isValidTelegramUsername(candidate)) continue;
    results.add(candidate);
  }

  return [...results].map((username) => ({ username, mode: "ai" as const }));
}
