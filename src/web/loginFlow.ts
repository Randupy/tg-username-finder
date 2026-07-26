import {
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { writeTextAtomic } from "../storage/atomic.js";

export type LoginPhase =
  | "idle"
  | "connecting"
  | "code"
  | "password"
  | "email_address"
  | "email_code"
  | "success"
  | "error"
  | "cancelled";

export interface LoginSnapshot {
  phase: LoginPhase;
  message: string;
  startedAt?: string;
  updatedAt: string;
}

interface PendingAnswer {
  phase: "code" | "password" | "email_address" | "email_code";
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

function sanitizeTelegramError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, "[скрыто]")
    .replace(/\s+/g, " ")
    .trim();
}

function replaceEnvValue(raw: string, key: string, value: string): string {
  const lines = raw ? raw.split(/\r?\n/) : [];
  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const next: string[] = [];
  for (const line of lines) {
    if (!assignment.test(line)) {
      next.push(line);
      continue;
    }
    // Нормализуем первую запись и удаляем возможные дубли, чтобы загрузчик
    // после перезапуска гарантированно увидел только новое значение.
    if (replaced) continue;
    replaced = true;
    next.push(`${key}=${value}`);
  }
  if (!replaced) next.push(`${key}=${value}`);
  return next.filter((line, index) => line !== "" || index < next.length - 1).join("\n") + "\n";
}

export function saveTelegramCredentials(
  projectRoot: string,
  apiIdInput: unknown,
  apiHashInput: unknown,
): void {
  const apiId = Number(apiIdInput);
  const apiHash = typeof apiHashInput === "string" ? apiHashInput.trim() : "";

  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error("API ID должен быть положительным целым числом");
  }
  if (!/^[a-fA-F0-9]{16,128}$/.test(apiHash)) {
    throw new Error("API Hash выглядит некорректно");
  }

  const envPath = resolve(projectRoot, ".env");
  let raw = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  raw = replaceEnvValue(raw, "TG_API_ID", String(apiId));
  raw = replaceEnvValue(raw, "TG_API_HASH", apiHash);
  writeTextAtomic(envPath, raw, 0o600);

  process.env.TG_API_ID = String(apiId);
  process.env.TG_API_HASH = apiHash;
}

export class TelegramLoginFlow {
  private readonly sessionPath: string;
  private client: TelegramClient | null = null;
  private pending: PendingAnswer | null = null;
  private flowId = 0;
  private terminalError: string | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private snapshot: LoginSnapshot = {
    phase: "idle",
    message: "Вход ещё не запускался",
    updatedAt: new Date().toISOString(),
  };

  constructor(private readonly projectRoot: string) {
    this.sessionPath = resolve(projectRoot, ".tg-session");
  }

  getStatus(): LoginSnapshot {
    return { ...this.snapshot };
  }

  private update(phase: LoginPhase, message: string, startedAt = this.snapshot.startedAt): void {
    this.snapshot = {
      phase,
      message,
      startedAt,
      updatedAt: new Date().toISOString(),
    };
  }

  private waitForAnswer(
    phase: "code" | "password" | "email_address" | "email_code",
    message: string,
  ): Promise<string> {
    if (this.pending) {
      this.pending.reject(new Error("Предыдущий шаг авторизации был заменён новым"));
    }
    this.update(phase, message);
    return new Promise<string>((resolveAnswer, rejectAnswer) => {
      this.pending = {
        phase,
        resolve: resolveAnswer,
        reject: rejectAnswer,
      };
    });
  }

  async start(phoneInput: unknown): Promise<LoginSnapshot> {
    if (["connecting", "code", "password", "email_address", "email_code"].includes(this.snapshot.phase)) {
      throw new Error("Авторизация уже выполняется");
    }

    const phone = typeof phoneInput === "string" ? phoneInput.replace(/[\s()-]/g, "") : "";
    if (!/^\+\d{8,15}$/.test(phone)) {
      throw new Error("Введите номер в международном формате, например +79991234567");
    }

    const apiIdRaw = process.env.TG_API_ID;
    const apiHash = process.env.TG_API_HASH;
    if (!apiIdRaw || !apiHash) {
      throw new Error("Сначала сохраните Telegram API ID и API Hash");
    }
    const apiId = Number(apiIdRaw);
    if (!Number.isInteger(apiId)) {
      throw new Error("Сохранённый Telegram API ID некорректен");
    }

    const currentFlow = ++this.flowId;
    this.terminalError = null;
    const startedAt = new Date().toISOString();
    this.update("connecting", "Подключаемся к Telegram…", startedAt);
    // Резервируем flow синхронно до первого await: второй одновременный
    // POST /login/start теперь увидит connecting и не создаст второй клиент.
    await this.cancelInternal(false);
    if (currentFlow !== this.flowId) return this.getStatus();

    const existingSession = existsSync(this.sessionPath)
      ? readFileSync(this.sessionPath, "utf-8").trim()
      : "";
    const client = new TelegramClient(new StringSession(existingSession), apiId, apiHash, {
      connectionRetries: 5,
    });
    this.client = client;

    this.timeout = setTimeout(() => {
      if (currentFlow === this.flowId) {
        void this.cancelInternal(true, "Время входа истекло. Запустите его ещё раз.");
      }
    }, 10 * 60 * 1000);
    this.timeout.unref();

    void (async () => {
      try {
        await client.start({
          phoneNumber: async () => phone,
          phoneCode: async (isCodeViaApp) =>
            this.waitForAnswer(
              "code",
              isCodeViaApp === false
                ? "Введите код, который Telegram прислал по SMS"
                : "Введите код, который Telegram прислал в приложение",
            ),
          password: async (hint) =>
            this.waitForAnswer(
              "password",
              hint
                ? `Аккаунт защищён 2FA — введите облачный пароль (подсказка: ${hint.slice(0, 80)})`
                : "Аккаунт защищён 2FA — введите облачный пароль",
            ),
          emailAddress: async () =>
            this.waitForAnswer(
              "email_address",
              "Telegram требует резервный email для входа — введите адрес",
            ),
          emailVerification: async (options) => ({
            type: "code",
            code: await this.waitForAnswer(
              "email_code",
              options.emailPattern
                ? `Введите код из письма на ${options.emailPattern}`
                : "Введите код подтверждения из email",
            ),
          }),
          firstAndLastNames: async () => {
            throw new Error("SIGNUP_NOT_SUPPORTED");
          },
          reCaptchaCallback: async () => {
            throw new Error("CAPTCHA_NOT_SUPPORTED");
          },
          onError: (error) => {
            const detail = sanitizeTelegramError(error);
            if (/SIGNUP_NOT_SUPPORTED/i.test(detail)) {
              this.terminalError =
                "Этот номер не привязан к аккаунту. Создание новых аккаунтов из Handle Radar отключено.";
              this.update("error", this.terminalError, startedAt);
              return Promise.resolve(true);
            }
            if (/CAPTCHA_NOT_SUPPORTED/i.test(detail)) {
              this.terminalError =
                "Telegram запросил CAPTCHA. Завершите вход в официальном клиенте и повторите попытку.";
              this.update("error", this.terminalError, startedAt);
              return Promise.resolve(true);
            }
            if (/PHONE_NUMBER_(?:BANNED|INVALID)|API_ID_INVALID|FLOOD_WAIT/i.test(detail)) {
              this.terminalError = `Telegram остановил вход: ${detail}`;
              this.update("error", this.terminalError, startedAt);
              return Promise.resolve(true);
            }
            const message = detail ? `Telegram: ${detail}` : "Telegram отклонил данные входа";
            if (this.snapshot.phase === "code") {
              this.update("code", `${message}. Проверьте код и попробуйте снова.`);
            } else if (this.snapshot.phase === "password") {
              this.update("password", `${message}. Проверьте пароль и попробуйте снова.`);
            } else if (this.snapshot.phase === "email_address") {
              this.update("email_address", `${message}. Проверьте email и попробуйте снова.`);
            } else if (this.snapshot.phase === "email_code") {
              this.update("email_code", `${message}. Проверьте код из email и попробуйте снова.`);
            } else {
              this.update("connecting", message);
            }
          },
        });

        if (currentFlow !== this.flowId) return;
        const authorized = await client.checkAuthorization();
        if (!authorized) {
          throw new Error("Telegram не подтвердил авторизацию");
        }
        const session = client.session.save() as unknown as string;
        writeTextAtomic(this.sessionPath, `${session}\n`, 0o600);
        this.pending = null;
        this.update("success", "Telegram подключён. Сессия сохранена локально.", startedAt);
      } catch (error) {
        if (currentFlow !== this.flowId || this.snapshot.phase === "cancelled") return;
        this.pending = null;
        this.update(
          "error",
          this.terminalError ??
            `Не удалось войти: ${sanitizeTelegramError(error) || "неизвестная ошибка"}`,
          startedAt,
        );
      } finally {
        if (currentFlow === this.flowId) {
          if (this.timeout) clearTimeout(this.timeout);
          this.timeout = null;
          try {
            await client.disconnect();
          } catch {
            // Соединение могло уже закрыться после ошибки/отмены.
          }
          if (this.client === client) this.client = null;
        }
      }
    })();

    return this.getStatus();
  }

  submitAnswer(valueInput: unknown): LoginSnapshot {
    if (!this.pending) {
      throw new Error("Сейчас Telegram не ожидает код или пароль");
    }
    const rawValue = typeof valueInput === "string" ? valueInput : "";
    // Пробелы могут быть частью 2FA-пароля; коды и email, напротив, безопасно
    // нормализовать по краям.
    const value = this.pending.phase === "password" ? rawValue : rawValue.trim();
    if (!value) {
      const labels: Record<PendingAnswer["phase"], string> = {
        code: "Введите код из Telegram",
        password: "Введите пароль 2FA",
        email_address: "Введите email",
        email_code: "Введите код из email",
      };
      throw new Error(labels[this.pending.phase]);
    }
    const pending = this.pending;
    this.pending = null;
    this.update("connecting", "Проверяем данные…");
    pending.resolve(value);
    return this.getStatus();
  }

  async cancel(): Promise<LoginSnapshot> {
    await this.cancelInternal(true, "Вход отменён");
    return this.getStatus();
  }

  private async cancelInternal(
    incrementFlow: boolean,
    message = "Вход отменён",
  ): Promise<void> {
    if (incrementFlow) this.flowId++;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    if (this.pending) {
      this.pending.reject(new Error(message));
      this.pending = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Уже отключён.
      }
    }
    if (incrementFlow) this.update("cancelled", message);
  }
}
