import { mkdirSync, writeFileSync } from "node:fs";
import { load } from "cheerio";
import type { CheckResult } from "../types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

interface FragmentStatus {
  available: boolean | "unknown";
  detail?: string;
  confidence: "high" | "low";
}

interface FragmentHttpPage {
  html: string;
  status: number;
  statusText: string;
  url: string;
  ok: boolean;
}

function looksLikeAntiBotPage(html: string, bodyText: string): boolean {
  const lowerHtml = html.toLowerCase();
  return (
    lowerHtml.includes("/cdn-cgi/challenge-platform/") ||
    lowerHtml.includes("cf-chl-") ||
    lowerHtml.includes("challenge-platform") ||
    bodyText.includes("checking your browser before accessing") ||
    bodyText.includes("verify you are human") ||
    bodyText.includes("enable javascript and cookies to continue") ||
    /cloudflare.{0,100}(?:challenge|ray id)|(?:challenge|ray id).{0,100}cloudflare/i.test(
      bodyText,
    )
  );
}

function isExpectedUsernameUrl(finalUrl: string, username: string): boolean {
  if (!finalUrl) return true; // Response из тестового fetch может не иметь URL.
  try {
    const url = new URL(finalUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "fragment.com" && host !== "www.fragment.com") return false;
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "").toLowerCase();
    if (path === `/username/${username.toLowerCase()}`) return true;
    // Для имён без собственной collectible-карточки Fragment штатно
    // перенаправляет /username/name на поиск /?query=name.
    return (
      path === "" &&
      (url.searchParams.get("query") ?? "").toLowerCase() === username.toLowerCase()
    );
  } catch {
    return false;
  }
}

function safeDebugName(username: string): string {
  return username.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "unknown";
}

/**
 * У Fragment на статичной HTML-странице почти всегда присутствует один и тот
 * же шаблонный текст про покупку/аукцион/оффер (инструкции, которые, судя по
 * всему, лежат в разметке всегда, а не только когда объект реально продаётся) —
 * поэтому наивный поиск слов "unavailable"/"sold"/"ton" ненадёжен и почти
 * гарантированно даёт ложные срабатывания.
 *
 * Единственная явно подтверждённая и специфичная формулировка, которую
 * Fragment показывает для юзернейма, который занят в Telegram, но НЕ выставлен
 * на продажу: "Someone already claimed this username on Telegram." Это и
 * используем как основной сигнал "занято".
 *
 * Формулировку для по-настоящему свободного (нигде не занятого) имени
 * достоверно найти не удалось — она либо специфична, либо требует JS-рендера.
 * Поэтому "available" здесь — вывод по остаточному принципу (никаких признаков
 * занятости не найдено), с явной пометкой низкой уверенности.
 *
 * У Fragment нет публичного API, поэтому третий раз молча гадать по HTML —
 * плохая идея: вместо этого перед массовым использованием пришлите мне
 * (или сохраните через --debug) HTML трёх заведомых случаев — (1) имя точно
 * свободно нигде, (2) занято в Telegram, но не продаётся, (3) занято и
 * выставлено на аукцион/оффер на Fragment — и я подгоню селекторы под
 * реальную разметку вместо предположений.
 */
function extractStatus(html: string, username?: string): FragmentStatus {
  const $ = load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").toLowerCase();

  if (looksLikeAntiBotPage(html, bodyText)) {
    return {
      available: "unknown",
      detail: "Fragment показал anti-bot/Cloudflare challenge вместо страницы юзернейма",
      confidence: "low",
    };
  }

  if (bodyText.includes("page not found")) {
    return { available: "unknown", detail: "Страница не найдена", confidence: "high" };
  }

  // Подтверждённый сигнал: занято в Telegram, но не выставлено на продажу
  if (bodyText.includes("someone already claimed this username on telegram")) {
    return { available: false, detail: "Занято в Telegram, не выставлено на продажу", confidence: "high" };
  }

  const headerStatus = $(".tm-section-header-status").first().text().replace(/\s+/g, " ").trim().toLowerCase();
  if (/\b(on auction|for sale|sold|taken)\b/.test(headerStatus)) {
    return {
      available: false,
      detail: `Статус Fragment: ${headerStatus}`,
      confidence: "high",
    };
  }

  // При штатном redirect на поиск разбираем ровно строку запрошенного имени.
  // "Unavailable / Not for sale" означает, что collectible-объекта на
  // Fragment нет; это полезный, но всё ещё эвристический сигнал.
  const targetUsername = username?.toLowerCase();
  const searchRow = targetUsername
    ? $(".tm-row-selectable")
        .toArray()
        .find((row) => {
          const value = $(row)
            .find(".table-cell-value-row .tm-value, .table-cell-value.tm-value")
            .first()
            .text();
          return value.trim().replace(/^@/, "").toLowerCase() === targetUsername;
        })
    : undefined;
  if (searchRow) {
    const rowText = $(searchRow).text().replace(/\s+/g, " ").trim().toLowerCase();
    const rowStatus = $(searchRow)
      .find(".tm-status-avail, .tm-status-unavail, .table-cell-status-thin")
      .map((_, element) => $(element).text().trim())
      .get()
      .join(" ")
      .toLowerCase();
    if (/\bunavailable\b/.test(rowStatus) && rowText.includes("not for sale")) {
      return {
        available: true,
        detail: "Collectible-карточка Fragment не найдена (Unavailable / Not for sale)",
        confidence: "low",
      };
    }
    if (/\b(on auction|for sale|sold|taken)\b/.test(rowText)) {
      return {
        available: false,
        detail: "Fragment показывает имя как занятое/выставленное",
        confidence: "high",
      };
    }
  }

  // Запасной сигнал для старой разметки, где ценник мог содержать текст TON.
  const priceNearBid =
    /(bid|price)[^.!?]{0,120}\d[\d\s,.]*\s*(ton|gram)\b/.test(bodyText);
  if (priceNearBid) {
    return { available: false, detail: "Похоже, выставлено на аукцион/продажу (не подтверждено на 100%)", confidence: "low" };
  }

  return {
    available: true,
    detail: "Признаков занятости не найдено — низкая уверенность, требует ручной проверки",
    confidence: "low",
  };
}

async function fetchWithHttp(
  username: string,
  debug?: boolean,
  timeoutMs = 15_000,
): Promise<FragmentHttpPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://fragment.com/username/${encodeURIComponent(username)}`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await res.text();
    if (debug) {
      mkdirSync("debug", { recursive: true });
      writeFileSync(`debug/fragment-${safeDebugName(username)}.html`, html, "utf-8");
    }
    return {
      html,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      ok: res.ok,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithPlaywright(
  username: string,
  debug?: boolean,
  timeoutMs = 15_000,
): Promise<string | null> {
  try {
    // Динамический импорт: playwright — опциональная зависимость,
    // не хотим требовать скачивание браузера тем, кто им не пользуется.
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ userAgent: USER_AGENT });
      await page.goto(`https://fragment.com/username/${encodeURIComponent(username)}`, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      const html = await page.content();
      if (debug) {
        mkdirSync("debug", { recursive: true });
        writeFileSync(`debug/fragment-js-${safeDebugName(username)}.html`, html, "utf-8");
      }
      return html;
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch {
    return null; // playwright не установлен или страница не открылась
  }
}

export async function checkFragment(
  username: string,
  opts: { debug?: boolean; usePlaywright?: boolean; timeoutMs?: number } = {},
): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    const httpPage = await fetchWithHttp(username, opts.debug, opts.timeoutMs);
    let status: FragmentStatus;

    if (!httpPage.ok) {
      const statusText = httpPage.statusText ? ` ${httpPage.statusText}` : "";
      status = {
        available: "unknown",
        detail: `Fragment вернул HTTP ${httpPage.status}${statusText}`,
        confidence: "low",
      };
    } else if (!isExpectedUsernameUrl(httpPage.url, username)) {
      status = {
        available: "unknown",
        detail: `Fragment перенаправил запрос на неожиданную страницу: ${httpPage.url}`,
        confidence: "low",
      };
    } else {
      status = extractStatus(httpPage.html, username);
    }

    if ((status.available === "unknown" || status.confidence === "low") && opts.usePlaywright) {
      const jsHtml = await fetchWithPlaywright(username, opts.debug, opts.timeoutMs);
      if (jsHtml) {
        status = extractStatus(jsHtml, username);
      } else {
        status.detail = (status.detail ?? "") + " (playwright недоступен/не открылась страница)";
      }
    }

    const detail =
      status.confidence === "low" ? `${status.detail ?? ""} [низкая уверенность]`.trim() : status.detail;

    return {
      username,
      source: "fragment",
      available: status.available,
      detail,
      confidence: status.confidence,
      checkedAt,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { username, source: "fragment", available: "unknown", detail, confidence: "low", checkedAt };
  }
}
