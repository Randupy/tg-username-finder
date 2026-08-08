import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { addFavorite, listFavorites } from "../src/favorites.js";
import type { FavoritePrice } from "../src/types.js";

test("favorites preserve price and are listed newest first", () => {
  const path = resolve(mkdtempSync(resolve(tmpdir(), "tg-favorites-")), "favorites.json");
  const older = {
    username: "oldname",
    source: "telegram",
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  const newer = {
    username: "newname",
    source: "fragment",
    price: { ton: 42.5, usd: 130, rub: 10_000 },
    addedAt: "2026-07-01T00:00:00.000Z",
  };

  writeFileSync(path, JSON.stringify([older, newer]), "utf-8");

  assert.deepEqual(
    listFavorites(undefined, path).map((favorite) => favorite.username),
    ["newname", "oldname"],
  );
  assert.deepEqual(listFavorites(undefined, path)[0].price, newer.price);

  const richPrice: FavoritePrice = {
    ton: 55,
    usd: 170,
    rub: 13_000,
    p10Ton: 30,
    p90Ton: 95,
    confidence: "medium",
    confidenceScore: 0.63,
    confidenceDefinition: "probability-within-2x",
    liquidity: { saleProbability90d: 0.48, outOfDistribution: false },
    releaseGatePassed: false,
    priceOutOfDistribution: true,
    oodScore: 0.81,
    modelDisagreementLog: 0.42,
    comparableEffectiveSampleSize: 3.5,
    trainedAt: "2026-07-30T12:00:00.000Z",
    trainedThrough: "2026-07-29T12:00:00.000Z",
    releaseGateReason: "non-temporal-evaluation",
    splitStrategy: "group-random",
    dataCurrent: true,
  };
  const updated = addFavorite(
    "newname",
    "fragment",
    "updated",
    path,
    richPrice,
  );
  assert.deepEqual(updated.price, richPrice);
  assert.equal(updated.addedAt, newer.addedAt);
  assert.deepEqual(
    JSON.parse(readFileSync(path, "utf-8")).find(
      (favorite: { username: string }) => favorite.username === "newname",
    ).price,
    richPrice,
  );
  assert.deepEqual(listFavorites(undefined, path)[0].price, richPrice);
});
