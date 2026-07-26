import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { loadEnvFile } from "../src/mtproto/env.js";
import { saveTelegramCredentials } from "../src/web/loginFlow.js";

test("saving Telegram credentials normalizes spaced assignments and removes duplicates", () => {
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "tg-username-web-env-"));
  const envPath = resolve(isolatedRoot, ".env");
  const previousApiId = process.env.TG_API_ID;
  const previousApiHash = process.env.TG_API_HASH;
  const newHash = "0123456789abcdef".repeat(2);

  try {
    writeFileSync(
      envPath,
      [
        "# existing settings stay intact",
        "KEEP_ME=yes",
        "  TG_API_ID = 111111",
        "TG_API_ID=222222",
        ` TG_API_HASH = ${"a".repeat(32)}`,
        `TG_API_HASH=${"b".repeat(32)}`,
        "",
      ].join("\r\n"),
      "utf-8",
    );

    saveTelegramCredentials(isolatedRoot, 987654, newHash);

    const saved = readFileSync(envPath, "utf-8");
    assert.deepEqual(
      saved.split(/\r?\n/).filter((line) => /^\s*TG_API_ID\s*=/.test(line)),
      ["TG_API_ID=987654"],
    );
    assert.deepEqual(
      saved.split(/\r?\n/).filter((line) => /^\s*TG_API_HASH\s*=/.test(line)),
      [`TG_API_HASH=${newHash}`],
    );
    assert.match(saved, /^KEEP_ME=yes$/m);
    assert.equal(process.env.TG_API_ID, "987654");
    assert.equal(process.env.TG_API_HASH, newHash);

    delete process.env.TG_API_ID;
    delete process.env.TG_API_HASH;
    loadEnvFile(envPath);
    assert.equal(process.env.TG_API_ID, "987654");
    assert.equal(process.env.TG_API_HASH, newHash);
  } finally {
    if (previousApiId === undefined) delete process.env.TG_API_ID;
    else process.env.TG_API_ID = previousApiId;
    if (previousApiHash === undefined) delete process.env.TG_API_HASH;
    else process.env.TG_API_HASH = previousApiHash;
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});
