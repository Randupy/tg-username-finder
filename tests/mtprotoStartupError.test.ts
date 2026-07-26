import assert from "node:assert/strict";
import test from "node:test";
import { telegramStartupAdvice } from "../src/mtproto/startupError.js";

test("explains that EACCES is a network permission error, not failed authorization", () => {
  const advice = telegramStartupAdvice(
    Object.assign(new Error("connect EACCES 149.154.167.51:443"), { code: "EACCES" }),
  ).join(" ");

  assert.match(advice, /не ошибка API ID/i);
  assert.match(advice, /обычном PowerShell/i);
  assert.doesNotMatch(advice, /выполните `npm run login`/i);
});

test("keeps login guidance for actual session/authentication failures", () => {
  const advice = telegramStartupAdvice(new Error("Telegram-сессия не авторизована")).join(" ");

  assert.match(advice, /npm run login/i);
});
