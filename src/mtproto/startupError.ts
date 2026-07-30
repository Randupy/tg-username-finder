const ACCESS_DENIED_CODES = new Set(["EACCES", "EPERM"]);
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code.toUpperCase();
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.match(
    /\b(EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/i,
  )?.[1]?.toUpperCase() ?? "";
}

export function telegramStartupAdvice(error: unknown): string[] {
  const code = errorCode(error);
  if (ACCESS_DENIED_CODES.has(code)) {
    return [
      "Это не ошибка API ID, API Hash или Telegram-сессии: процессу Node.js запрещено открыть сетевое соединение с Telegram.",
      "Если Token запущен из Codex/IDE-песочницы, остановите этот сервер и запустите `npm run web` в обычном PowerShell. При запросе Windows разрешите node.exe доступ к частной сети.",
    ];
  }
  if (NETWORK_CODES.has(code)) {
    return [
      "Не удалось установить сетевое соединение с Telegram. Проверьте интернет, VPN/proxy и правила брандмауэра для node.exe.",
      "Авторизация может быть исправна: сначала восстановите доступ к 149.154.167.51:443, затем повторите поиск.",
    ];
  }
  return [
    "Проверьте Telegram-сессию: откройте раздел «Настройка» в Token или выполните `npm run login`.",
    "Временный `--legacy-web` не требует MTProto-входа, но использует менее надёжную HTML-эвристику.",
  ];
}
