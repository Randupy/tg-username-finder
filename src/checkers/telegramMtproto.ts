import { Api, type TelegramClient } from "teleproto";
import type { CheckResult } from "../types.js";

/**
 * Официальный, детерминированный способ проверки юзернейма в Telegram —
 * `account.checkUsername`. Это ровно тот RPC-вызов, который делает сам
 * клиент Telegram, когда вы вводите имя в Settings → Username. Никакого
 * скрейпинга и угадывания по HTML:
 *
 *  - true → имя свободно (подтверждено сервером Telegram)
 *  - USERNAME_OCCUPIED → имя занято
 *  - USERNAME_PURCHASE_AVAILABLE → имя можно только купить на Fragment,
 *    то есть бесплатно назначить его нельзя
 *  - USERNAME_INVALID → имя в принципе не проходит по формату
 *
 * Требует один раз выполненный `npm run login` (см. mtproto/login.ts).
 */

interface RpcErrorLike {
  message?: unknown;
  errorMessage?: unknown;
  code?: unknown;
  seconds?: unknown;
  name?: unknown;
}

function rpcErrorInfo(err: unknown): {
  message: string;
  errorMessage: string;
  code?: number;
  seconds?: number;
  searchable: string;
} {
  const obj = err && typeof err === "object" ? (err as RpcErrorLike) : {};
  const message =
    typeof obj.message === "string"
      ? obj.message
      : err instanceof Error
        ? err.message
        : String(err);
  const errorMessage = typeof obj.errorMessage === "string" ? obj.errorMessage : "";
  const name = typeof obj.name === "string" ? obj.name : "";
  const numericCode = Number(obj.code);
  const numericSeconds = Number(obj.seconds);

  return {
    message,
    errorMessage,
    code: Number.isFinite(numericCode) ? numericCode : undefined,
    seconds:
      Number.isFinite(numericSeconds) && numericSeconds >= 0
        ? Math.ceil(numericSeconds)
        : undefined,
    searchable: `${errorMessage} ${name} ${message}`,
  };
}

function floodWaitSeconds(info: ReturnType<typeof rpcErrorInfo>): number | undefined {
  if (info.seconds !== undefined) return info.seconds;
  const match = info.searchable.match(
    /(?:FLOOD_WAIT_|please\s+wait\s+|a\s+wait\s+of\s+)(\d+)\s*(?:seconds?)?/i,
  );
  return match ? Number(match[1]) : undefined;
}

export async function checkTelegramMtproto(
  username: string,
  client: TelegramClient,
): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();

  try {
    const result = await client.invoke(new Api.account.CheckUsername({ username }));

    return {
      username,
      source: "telegram",
      available: Boolean(result),
      detail: result
        ? "Подтверждено Telegram API (account.checkUsername): свободно"
        : "Подтверждено Telegram API (account.checkUsername): занято",
      confidence: "high",
      checkedAt,
    };
  } catch (err) {
    const info = rpcErrorInfo(err);

    if (/USERNAME_INVALID/i.test(info.searchable)) {
      return {
        username,
        source: "telegram",
        available: "invalid",
        detail: "Telegram отклонил формат имени (USERNAME_INVALID) — не подходит под правила",
        confidence: "high",
        checkedAt,
      };
    }

    if (/USERNAME_OCCUPIED/i.test(info.searchable)) {
      return {
        username,
        source: "telegram",
        available: false,
        detail: "Подтверждено Telegram API: имя уже занято (USERNAME_OCCUPIED)",
        confidence: "high",
        checkedAt,
      };
    }

    if (/USERNAME_PURCHASE_AVAILABLE/i.test(info.searchable)) {
      return {
        username,
        source: "telegram",
        available: false,
        detail:
          "Telegram сообщает, что имя доступно только для покупки на Fragment " +
          "(USERNAME_PURCHASE_AVAILABLE)",
        confidence: "high",
        checkedAt,
      };
    }

    const waitSeconds = floodWaitSeconds(info);
    if (waitSeconds !== undefined || info.code === 420 || /^FLOOD$/i.test(info.errorMessage)) {
      const waitHint =
        waitSeconds !== undefined
          ? `, подождите ${waitSeconds} сек.`
          : "";
      return {
        username,
        source: "telegram",
        available: "unknown",
        detail: `Rate limit от Telegram${waitHint} и увеличьте --delay`,
        confidence: "low",
        checkedAt,
      };
    }

    return {
      username,
      source: "telegram",
      available: "unknown",
      detail: `Ошибка MTProto: ${info.message}`,
      confidence: "low",
      checkedAt,
    };
  }
}
