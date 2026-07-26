import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { addFavorite, listFavorites } from "../src/favorites.js";

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

  const updated = addFavorite(
    "newname",
    "fragment",
    "updated",
    path,
    { ton: 55, usd: 170, rub: 13_000 },
  );
  assert.deepEqual(updated.price, { ton: 55, usd: 170, rub: 13_000 });
  assert.equal(updated.addedAt, newer.addedAt);
  assert.deepEqual(
    JSON.parse(readFileSync(path, "utf-8")).find(
      (favorite: { username: string }) => favorite.username === "newname",
    ).price,
    { ton: 55, usd: 170, rub: 13_000 },
  );
});
