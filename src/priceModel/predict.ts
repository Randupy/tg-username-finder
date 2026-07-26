import { existsSync, readFileSync } from "node:fs";
import { MLP } from "../ml/mlp.js";
import { convertTon, getRates } from "../rates.js";
import { extractFeatures } from "./features.js";
import { MODEL_PATH, type PriceModelFile } from "./train.js";

export interface PricePrediction {
  ton: number;
  usd: number;
  rub: number;
}

let cachedModel: { mlp: MLP; file: PriceModelFile } | null = null;

export function priceModelExists(): boolean {
  return existsSync(MODEL_PATH);
}

function loadModel(): { mlp: MLP; file: PriceModelFile } {
  if (cachedModel) return cachedModel;
  if (!existsSync(MODEL_PATH)) {
    throw new Error(
      `Модель не найдена (${MODEL_PATH}). Сначала соберите данные (npm run collect-sales), ` +
        "затем обучите модель (npm run train-price).",
    );
  }
  const file: PriceModelFile = JSON.parse(readFileSync(MODEL_PATH, "utf-8"));
  const mlp = MLP.fromJSON(file.mlp);
  cachedModel = { mlp, file };
  return cachedModel;
}

export async function predictPrice(username: string): Promise<PricePrediction> {
  const { mlp, file } = loadModel();
  const features = extractFeatures(username);
  const normInput = features.map((v, i) => (v - file.featureMean[i]) / file.featureStd[i]);
  const normOut = mlp.predict(normInput)[0];
  const logPrice = normOut * file.targetStd + file.targetMean;
  const ton = Math.max(0, Math.exp(logPrice) - 1);

  const rates = await getRates();
  return convertTon(ton, rates);
}
