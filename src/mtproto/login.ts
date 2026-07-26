import { createInterface } from "node:readline/promises";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { loadEnvFile } from "./env.js";
import { readSavedSession, saveSession, SESSION_PATH } from "./client.js";

loadEnvFile();

function ask(question: string): () => Promise<string> {
  return async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

/**
 * Разовый интерактивный вход под своим Telegram-аккаунтом (номер телефона +
 * код из приложения + пароль 2FA, если включён). Это тот же протокол, что
 * использует официальный клиент Telegram — никаких серых схем. Токен/сессия
 * сохраняются в .tg-session (в .gitignore), чтобы логиниться только один раз.
 */
export async function runLogin(): Promise<void> {
  const apiIdRaw = process.env.TG_API_ID;
  const apiHash = process.env.TG_API_HASH;

  if (!apiIdRaw || !apiHash) {
    console.error(
      "Не заданы TG_API_ID / TG_API_HASH.\n" +
        "1. Зайдите на https://my.telegram.org под своим номером\n" +
        "2. 'API development tools' → создайте приложение (любое название)\n" +
        "3. Скопируйте api_id и api_hash в .env (см. .env.example)\n" +
        "4. Запустите npm run login ещё раз",
    );
    process.exit(1);
  }

  const apiId = Number(apiIdRaw);
  const existing = readSavedSession();

  const client = new TelegramClient(new StringSession(existing), apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log("Подключаюсь к Telegram...");

  await client.start({
    phoneNumber: ask("Номер телефона (с кодом страны, напр. +79991234567): "),
    password: ask("Пароль двухфакторной аутентификации (если не включена — просто Enter): "),
    phoneCode: ask("Код из Telegram (пришёл в приложение/SMS): "),
    onError: (err) => console.error("Ошибка авторизации:", err.message ?? err),
  });

  const sessionString = client.session.save() as unknown as string;
  saveSession(sessionString);

  console.log(`\n✅ Вход выполнен, сессия сохранена в ${SESSION_PATH}`);
  console.log("Теперь можно запускать: npm run search -- --source both\n");

  await client.disconnect();
}
