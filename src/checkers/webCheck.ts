import { mkdirSync, writeFileSync } from "node:fs";
import type { CheckResult } from "../types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * ⚠️ ЭТО ЛЕГАСИ-ПУТЬ (--legacy-web). По умолчанию используется
 * checkers/telegramMtproto.ts — официальный, детерминированный метод
 * (account.checkUsername через MTProto), который не гадает по HTML.
 *
 * Ограничения этой эвристики, из-за которых бывают ложные срабатывания:
 *  - HTTP 404 отдаётся и на свободные имена, и иногда на приватные аккаунты,
 *    которые никогда не открывали t.me-ссылку — отличить одно от другого
 *    по HTTP-коду нельзя.
 *  - Заголовок "Telegram: Contact @<username>" без блока "tgme_page_extra"
 *    обычно означает "свободно", но так же выглядят некоторые приватные
 *    боты/каналы без описания и подписчиков.
 *  - Скрейпинг никогда не скажет вам, что имя в принципе НЕВАЛИДНО по
 *    правилам Telegram (USERNAME_INVALID) — вместо этого он либо вернёт 404
 *    (похоже на "свободно"), либо не найдёт tgme_page_extra — тоже "похоже
 *    на свободно". Отсюда и ложные "свободные", которые на деле некорректны.
 *
 * Используйте --debug, чтобы сохранить HTML в ./debug/ и сверить руками,
 * но относитесь к этому источнику как к low-confidence подсказке, а не
 * как к финальному ответу.
 */
function isAvailableFromHtml(html: string, username: string): boolean {
  const genericTitleRegex = new RegExp(
    `<title>\\s*Telegram:\\s*Contact\\s*@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</title>`,
    "i",
  );
  const hasGenericTitle = genericTitleRegex.test(html);
  const hasExtraInfo = html.includes("tgme_page_extra");

  return hasGenericTitle && !hasExtraInfo;
}

export async function checkTelegramWeb(
  username: string,
  opts: { debug?: boolean; timeoutMs?: number } = {},
): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  try {
    const res = await fetch(`https://t.me/${encodeURIComponent(username)}`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const html = await res.text();

    if (opts.debug) {
      mkdirSync("debug", { recursive: true });
      writeFileSync(`debug/${username}.html`, html, "utf-8");
    }

    if (res.status === 404) {
      return {
        username,
        source: "telegram",
        available: true,
        detail: "HTTP 404 [эвристика, низкая уверенность]",
        confidence: "low",
        checkedAt,
      };
    }

    if (res.status === 429) {
      return {
        username,
        source: "telegram",
        available: "unknown",
        detail: "HTTP 429 — попали в rate limit, увеличьте --delay",
        confidence: "low",
        checkedAt,
      };
    }

    if (!res.ok) {
      return {
        username,
        source: "telegram",
        available: "unknown",
        detail: `HTTP ${res.status}`,
        confidence: "low",
        checkedAt,
      };
    }

    const available = isAvailableFromHtml(html, username);
    const detail = available
      ? "generic-страница без tgme_page_extra [эвристика, низкая уверенность]"
      : "найдена конкретная страница профиля (реальное имя/подписчики)";
    return { username, source: "telegram", available, detail, confidence: "low", checkedAt };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { username, source: "telegram", available: "unknown", detail, confidence: "low", checkedAt };
  } finally {
    clearTimeout(timeout);
  }
}
