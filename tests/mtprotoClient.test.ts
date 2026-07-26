import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramClient } from "teleproto";
import {
  connectAndAuthorizeClient,
  disconnectClient,
  getClient,
} from "../src/mtproto/client.js";

function fakeClient(parts: {
  connect?: () => Promise<void>;
  checkAuthorization?: () => Promise<boolean>;
  disconnect?: () => Promise<void>;
}): TelegramClient {
  return {
    connect: parts.connect ?? (async () => undefined),
    checkAuthorization: parts.checkAuthorization ?? (async () => true),
    disconnect: parts.disconnect ?? (async () => undefined),
  } as unknown as TelegramClient;
}

test("a partially connected client is disconnected without masking its original error", async () => {
  const original = new Error("connect failed");
  let disconnects = 0;
  const client = fakeClient({
    connect: async () => {
      throw original;
    },
    disconnect: async () => {
      disconnects++;
      throw new Error("cleanup failed");
    },
  });

  await assert.rejects(connectAndAuthorizeClient(client), (error) => error === original);
  assert.equal(disconnects, 1);
});

test("an unauthorized client is disconnected", async () => {
  let disconnects = 0;
  const client = fakeClient({
    checkAuthorization: async () => false,
    disconnect: async () => {
      disconnects++;
    },
  });

  await assert.rejects(connectAndAuthorizeClient(client), /сессия недействительна/i);
  assert.equal(disconnects, 1);
});

test("a rejected singleton is cleared so a later call can retry", async (t) => {
  const previousApiId = process.env.TG_API_ID;
  const previousApiHash = process.env.TG_API_HASH;
  t.after(async () => {
    if (previousApiId === undefined) delete process.env.TG_API_ID;
    else process.env.TG_API_ID = previousApiId;
    if (previousApiHash === undefined) delete process.env.TG_API_HASH;
    else process.env.TG_API_HASH = previousApiHash;
    await disconnectClient();
  });

  delete process.env.TG_API_ID;
  delete process.env.TG_API_HASH;
  await assert.rejects(getClient(), /TG_API_ID \/ TG_API_HASH/);
  await disconnectClient();

  process.env.TG_API_ID = "not-a-number";
  process.env.TG_API_HASH = "hash";
  await assert.rejects(getClient(), /TG_API_ID должен быть числом/);
});
