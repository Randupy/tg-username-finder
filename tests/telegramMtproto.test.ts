import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramClient } from "teleproto";
import { checkTelegramMtproto } from "../src/checkers/telegramMtproto.js";

function rejectingClient(error: unknown): TelegramClient {
  return {
    invoke: async () => {
      throw error;
    },
  } as unknown as TelegramClient;
}

function resolvingClient(value: boolean): TelegramClient {
  return {
    invoke: async () => value,
  } as unknown as TelegramClient;
}

function rpcError(
  message: string,
  fields: { errorMessage?: string; code?: number; seconds?: number } = {},
): Error {
  return Object.assign(new Error(message), fields);
}

test("maps successful account.checkUsername Bool results", async () => {
  const free = await checkTelegramMtproto("free_name", resolvingClient(true));
  const taken = await checkTelegramMtproto("taken_name", resolvingClient(false));

  assert.equal(free.available, true);
  assert.equal(free.confidence, "high");
  assert.equal(taken.available, false);
  assert.equal(taken.confidence, "high");
});

test("reads teleproto errorMessage instead of guessing from human-readable message", async (t) => {
  await t.test("USERNAME_INVALID", async () => {
    const result = await checkTelegramMtproto(
      "bad",
      rejectingClient(
        rpcError("The provided username is not valid. (caused by account.CheckUsername)", {
          errorMessage: "USERNAME_INVALID",
          code: 400,
        }),
      ),
    );

    assert.equal(result.available, "invalid");
    assert.equal(result.confidence, "high");
  });

  await t.test("USERNAME_OCCUPIED", async () => {
    const result = await checkTelegramMtproto(
      "telegram",
      rejectingClient(
        rpcError("The provided username is already occupied. (caused by account.CheckUsername)", {
          errorMessage: "USERNAME_OCCUPIED",
          code: 400,
        }),
      ),
    );

    assert.equal(result.available, false);
    assert.equal(result.confidence, "high");
    assert.match(result.detail ?? "", /занято/i);
  });

  await t.test("USERNAME_PURCHASE_AVAILABLE", async () => {
    const result = await checkTelegramMtproto(
      "premium",
      rejectingClient(
        rpcError(
          "The specified username can be purchased on https://fragment.com. " +
            "(caused by account.CheckUsername)",
          {
            errorMessage: "USERNAME_PURCHASE_AVAILABLE",
            code: 400,
          },
        ),
      ),
    );

    assert.equal(result.available, false);
    assert.equal(result.confidence, "high");
    assert.match(result.detail ?? "", /Fragment/);
  });
});

test("extracts FLOOD_WAIT duration from teleproto's structural fields", async () => {
  const result = await checkTelegramMtproto(
    "abcde",
    rejectingClient(
      rpcError("Please wait 73 seconds before repeating the action.", {
        errorMessage: "FLOOD",
        code: 420,
        seconds: 73,
      }),
    ),
  );

  assert.equal(result.available, "unknown");
  assert.equal(result.confidence, "low");
  assert.match(result.detail ?? "", /73 сек/);
});

test("keeps unrelated MTProto errors unknown", async () => {
  const result = await checkTelegramMtproto(
    "abcde",
    rejectingClient(rpcError("AUTH_KEY_UNREGISTERED", { errorMessage: "AUTH_KEY_UNREGISTERED", code: 401 })),
  );

  assert.equal(result.available, "unknown");
  assert.match(result.detail ?? "", /AUTH_KEY_UNREGISTERED/);
});
