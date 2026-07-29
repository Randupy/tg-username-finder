#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { generateCandidates } from "./generator.js";
import { checkTelegramWeb } from "./checkers/webCheck.js";
import { checkTelegramMtproto } from "./checkers/telegramMtproto.js";
import { checkFragment } from "./checkers/fragmentCheck.js";
import { addFavorite, listFavorites, removeFavorite } from "./favorites.js";
import { disconnectClient, getClient } from "./mtproto/client.js";
import { runLogin } from "./mtproto/login.js";
import { telegramStartupAdvice } from "./mtproto/startupError.js";
import type {
  CheckResult,
  DigitsPolicy,
  FavoritePrice,
  GenMode,
  SearchOptions,
  Source,
  SourceOption,
  WordPosition,
} from "./types.js";
import { collectSoldHistory } from "./priceData/soldHistory.js";
import { loadSoldHistory, mergeSoldHistory, saveSoldHistory } from "./priceData/store.js";
import { trainPriceModel } from "./priceModel/train.js";
import {
  predictPrice,
  priceModelExists,
  type PricePrediction,
} from "./priceModel/predict.js";
import { trainGeneratorModel } from "./generatorModel/train.js";
import { generateWithModel, generatorModelExists } from "./generatorModel/generate.js";
import { randomDelayMs, safeModeRange } from "./pacing.js";

const program = new Command();

program
  .name("tg-username-finder")
  .description("Поиск свободных юзернеймов в Telegram и на Fragment с фильтрами и избранным");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(baseMs: number): number {
  const spread = baseMs * 0.3;
  return baseMs + (Math.random() * spread * 2 - spread);
}

/** Пауза перед следующим запросом: широкий случайный диапазон в безопасном режиме, иначе обычный ±30% jitter. */
function nextDelayMs(baseMs: number, safeMode: boolean): number {
  return safeMode ? randomDelayMs(safeModeRange(baseMs)) : jitter(baseMs);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

async function estimatePrices(
  usernames: readonly string[],
  heading: string,
): Promise<Map<string, PricePrediction>> {
  const estimates = new Map<string, PricePrediction>();
  console.log(`\n${heading}`);
  for (const username of new Set(usernames)) {
    try {
      const prediction = await predictPrice(username);
      estimates.set(username, prediction);
      console.log(
        `  ${username} — ≈${prediction.ton.toFixed(1)} TON ` +
          `(≈$${prediction.usd.toFixed(2)} / ≈₽${prediction.rub.toFixed(0)})`,
      );
    } catch (err) {
      console.log(
        `  ${username} — не удалось оценить (${err instanceof Error ? err.message : err})`,
      );
    }
  }
  return estimates;
}

function withPriceEstimates<T extends { username: string }>(
  items: readonly T[],
  estimates: ReadonlyMap<string, PricePrediction>,
): Array<T & { estimatedPrice?: PricePrediction }> {
  return items.map((item) => {
    const estimatedPrice = estimates.get(item.username);
    return estimatedPrice ? { ...item, estimatedPrice } : { ...item };
  });
}

function integerOption(
  raw: unknown,
  label: string,
  min: number,
  max: number,
): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`${label}: требуется целое число от ${min} до ${max}`);
    process.exit(1);
  }
  return value;
}

function numberOption(
  raw: unknown,
  label: string,
  min: number,
  max: number,
): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.error(`${label}: требуется число от ${min} до ${max}`);
    process.exit(1);
  }
  return value;
}

function normalizeUsernameForCli(usernameRaw: string, source?: Source): string {
  const username = usernameRaw.trim().replace(/^@/, "").toLowerCase();
  const structurallyValid =
    /^[a-z][a-z0-9_]{3,31}$/.test(username) &&
    !username.includes("__") &&
    !username.endsWith("_");
  if (!structurallyValid || (source === "telegram" && username.length < 5)) {
    console.error(
      source === "telegram"
        ? "Некорректный Telegram-юзернейм: 5–32 символа, первая — буква, далее a–z, 0–9 и _"
        : "Некорректный юзернейм: 4–32 символа, первая — буква, далее a–z, 0–9 и _",
    );
    process.exit(1);
  }
  return username;
}

/** Общий значок для набора результатов по ОДНОМУ юзернейму (по всем проверенным источникам). */
function overallIcon(rs: CheckResult[]): string {
  if (rs.some((r) => r.available === false)) return "❌";
  if (rs.some((r) => r.available === "invalid")) return "🚫";
  if (rs.every((r) => r.available === true)) {
    return rs.every((r) => r.confidence === "high") ? "✅" : "⚠️";
  }
  return "❓";
}

/** Короткая метка статуса для одного источника — для однострочного вывода по кандидату. */
function statusLabel(r: CheckResult): string {
  if (r.available === true) {
    return r.confidence === "low" ? "свободно (низкая уверенность)" : "свободно";
  }
  if (r.available === false) return "занято";
  if (r.available === "invalid") return "невалидный формат";
  return r.detail ? `не определено (${r.detail})` : "не определено";
}

/** Одна итоговая строка на кандидата, объединяющая результаты всех проверенных источников. */
function formatCandidateLine(username: string, rs: CheckResult[]): string {
  const parts = rs.map((r) => `${r.source}: ${statusLabel(r)}`);
  return `${overallIcon(rs)} ${username} — ${parts.join(", ")}`;
}

program
  .command("search")
  .description("Сгенерировать кандидатов и проверить их доступность")
  .option("--source <source>", "telegram | fragment | both", "both")
  .option("--mode <mode>", "readable | random | word | translit | dictionary | compound | both", "both")
  .option("--min-length <n>", "минимальная длина", "5")
  .option("--max-length <n>", "максимальная длина", "5")
  .option("--digits <policy>", "exclude | allow | require", "exclude")
  .option("--count <n>", "сколько кандидатов сгенерировать", "20")
  .option("--charset <chars>", "свой набор символов для random/word-режимов")
  .option("--word <text>", "своё слово, которое должно войти в юзернейм (только с --mode word)")
  .option(
    "--word-position <position>",
    "start | middle | end | any — где должно стоять --word (только с --mode word)",
    "any",
  )
  .option("--delay <ms>", "пауза между запросами, мс", "2000")
  .option(
    "--safe-mode",
    "случайная широкая пауза между запросами вместо предсказуемого jitter (снижает риск flood-limit)",
    false,
  )
  .option("--out <path>", "куда сохранить результаты (JSON)")
  .option("--debug", "сохранять сырой HTML в ./debug для калибровки эвристик Fragment", false)
  .option("--dry-run", "только сгенерировать кандидатов, без сетевых запросов", false)
  .option("--playwright", "использовать Playwright как фолбэк для Fragment (JS-рендер)", false)
  .option(
    "--legacy-web",
    "проверять Telegram старым HTML-скрейпингом вместо официального MTProto (не рекомендуется)",
    false,
  )
  .option(
    "--estimate-price",
    "оценить примерную цену свободных юзернеймов обученной моделью (npm run train-price)",
    false,
  )
  .option(
    "--show-taken",
    "включить занятые/некорректные варианты в --out и таблицу результатов (по умолчанию скрыты)",
    false,
  )
  .action(async (raw) => {
    const source = raw.source as SourceOption;
    const mode = raw.mode as GenMode;
    const digits = raw.digits as DigitsPolicy;

    if (!["telegram", "fragment", "both"].includes(source)) {
      console.error(`Неверный --source: ${source}`);
      process.exit(1);
    }
    if (
      !["readable", "random", "word", "translit", "dictionary", "compound", "both"].includes(mode)
    ) {
      console.error(`Неверный --mode: ${mode}`);
      process.exit(1);
    }
    if (!["exclude", "allow", "require"].includes(digits)) {
      console.error(`Неверный --digits: ${digits}`);
      process.exit(1);
    }
    if (mode === "translit" && digits === "require") {
      console.error(
        "--mode translit генерирует точный транслит одного русского существительного и не добавляет цифры. Используйте --digits exclude или allow.",
      );
      process.exit(1);
    }

    const wordPosition = raw.wordPosition as WordPosition;
    if (mode === "word") {
      if (!raw.word) {
        console.error("--mode word требует --word <текст>, например --word big");
        process.exit(1);
      }
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(raw.word)) {
        console.error("--word должен начинаться с буквы и содержать только латинские буквы и цифры");
        process.exit(1);
      }
      if (!["start", "middle", "end", "any"].includes(wordPosition)) {
        console.error(`Неверный --word-position: ${wordPosition}`);
        process.exit(1);
      }
    }

    const opts: SearchOptions = {
      source,
      mode,
      minLength: integerOption(raw.minLength, "--min-length", source === "fragment" ? 4 : 5, 32),
      maxLength: integerOption(raw.maxLength, "--max-length", source === "fragment" ? 4 : 5, 32),
      digits,
      count: integerOption(raw.count, "--count", 1, 1000),
      charset: raw.charset
        ? [...new Set(String(raw.charset).toLowerCase())].join("")
        : undefined,
      word: raw.word,
      wordPosition,
      delayMs: integerOption(raw.delay, "--delay", 0, 60_000),
      safeMode: Boolean(raw.safeMode),
      outPath: raw.out,
      debug: Boolean(raw.debug),
      dryRun: Boolean(raw.dryRun),
      usePlaywright: Boolean(raw.playwright),
      legacyWeb: Boolean(raw.legacyWeb),
    };
    const showTaken = Boolean(raw.showTaken);

    if (opts.minLength > opts.maxLength) {
      console.error("--min-length не может быть больше --max-length");
      process.exit(1);
    }
    if (opts.charset && !/^[a-z]+$/.test(opts.charset)) {
      console.error("--charset может содержать только латинские буквы");
      process.exit(1);
    }

    if (opts.mode === "word" && opts.word) {
      if (opts.word.length > opts.maxLength) {
        console.error(
          `Слово "${opts.word}" (${opts.word.length} симв.) длиннее --max-length (${opts.maxLength})`,
        );
        process.exit(1);
      }
      if (opts.wordPosition === "middle" && opts.maxLength - opts.word.length < 2) {
        console.error(
          `--word-position middle требует хотя бы по 1 символу с каждой стороны; ` +
            `увеличьте --max-length минимум до ${opts.word.length + 2}`,
        );
        process.exit(1);
      }
      if (
        opts.digits === "require" &&
        !/\d/.test(opts.word) &&
        opts.word.length >= opts.maxLength
      ) {
        console.error(
          "--digits require требует место для цифры: увеличьте --max-length или добавьте цифру в --word",
        );
        process.exit(1);
      }
    }

    console.log(
      `Генерирую кандидатов: mode=${opts.mode}, длина=${opts.minLength}-${opts.maxLength}, digits=${opts.digits}, count=${opts.count}\n`,
    );

    const candidates = generateCandidates(opts);
    console.log(`Сгенерировано уникальных кандидатов: ${candidates.length}\n`);
    if (candidates.length === 0) {
      console.error("Не удалось сгенерировать ни одного кандидата с этими параметрами.");
      process.exitCode = 1;
      return;
    }
    if (candidates.length < opts.count) {
      console.log(
        `Получилось меньше запрошенного (${candidates.length} из ${opts.count}): ` +
          "пространство вариантов слишком узкое для выбранных фильтров.\n",
      );
    }

    if (opts.dryRun) {
      for (const c of candidates) {
        console.log(`  [${c.mode}] ${c.username}`);
      }
      if (opts.outPath) {
        writeJson(opts.outPath, candidates);
        console.log(`\nКандидаты сохранены в ${opts.outPath}`);
      }
      return;
    }

    const sourcesToCheck: Source[] =
      opts.source === "both" ? ["telegram", "fragment"] : [opts.source as Source];

    // Telegram по умолчанию проверяется официальным MTProto-методом — для
    // этого нужен разово выполненный `npm run login`. --legacy-web оставляет
    // старый HTML-скрейпинг для тех, кто пока не хочет логиниться, но с
    // явным предупреждением о его ненадёжности.
    let telegramClient: Awaited<ReturnType<typeof getClient>> | null = null;
    if (sourcesToCheck.includes("telegram") && !opts.legacyWeb) {
      try {
        telegramClient = await getClient();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ Не удалось использовать официальную проверку Telegram: ${message}`);
        for (const advice of telegramStartupAdvice(err)) console.error(advice);
        process.exit(1);
      }
    } else if (sourcesToCheck.includes("telegram") && opts.legacyWeb) {
      console.log(
        "⚠️  --legacy-web: проверяю Telegram старым HTML-скрейпингом — возможны ложные срабатывания.\n",
      );
    }

    if (opts.safeMode) {
      const range = safeModeRange(opts.delayMs);
      console.log(
        `🛡️  Безопасный режим: пауза между запросами случайная, от ${Math.round(range.minMs / 1000)} ` +
          `до ${Math.round(range.maxMs / 1000)} сек.\n`,
      );
    }

    const results: CheckResult[] = [];

    for (const candidate of candidates) {
      const candidateResults: CheckResult[] = [];

      for (const src of sourcesToCheck) {
        // Once a source has already returned a definitive negative (taken or
        // an invalid format), checking the remaining sources can't change the
        // outcome for this candidate — it only spends an extra Fragment/
        // Telegram request and adds flood-limit risk for nothing.
        const alreadyRuledOut = candidateResults.some(
          (r) => r.available === false || r.available === "invalid",
        );
        if (alreadyRuledOut) break;

        const result =
          src === "telegram"
            ? opts.legacyWeb
              ? await checkTelegramWeb(candidate.username, { debug: opts.debug })
              : await checkTelegramMtproto(candidate.username, telegramClient!)
            : await checkFragment(candidate.username, { debug: opts.debug, usePlaywright: opts.usePlaywright });

        candidateResults.push(result);
        results.push(result);

        await sleep(nextDelayMs(opts.delayMs, Boolean(opts.safeMode)));
      }

      console.log(formatCandidateLine(candidate.username, candidateResults));
    }

    if (telegramClient) {
      await disconnectClient();
    }

    const invalid = results.filter((r) => r.available === "invalid");
    const unknown = results.filter((r) => r.available === "unknown");
    const takenByAnySource = new Set(
      results.filter((r) => r.available === false).map((r) => r.username),
    );

    // Не смешиваем три разных уровня утверждения:
    // 1) подтверждено всеми источниками с высокой уверенностью;
    // 2) все источники вернули true, но хотя бы один ответ эвристический;
    // 3) проверен только один из двух источников.
    const byUsername = new Map<string, CheckResult[]>();
    for (const r of results) {
      if (!byUsername.has(r.username)) byUsername.set(r.username, []);
      byUsername.get(r.username)!.push(r);
    }

    const confirmedFree: string[] = [];
    const likelyFree: string[] = [];
    const partiallyChecked: { username: string; checkedSources: string[] }[] = [];

    for (const [username, rs] of byUsername) {
      if (takenByAnySource.has(username)) continue;
      if (rs.some((r) => r.available === "invalid")) continue;
      const allTrue = rs.every((r) => r.available === true);
      if (!allTrue || rs.length !== sourcesToCheck.length) continue;

      if (sourcesToCheck.length < 2) {
        partiallyChecked.push({ username, checkedSources: rs.map((r) => r.source) });
      } else if (rs.every((r) => r.confidence === "high")) {
        confirmedFree.push(username);
      } else {
        likelyFree.push(username);
      }
    }

    console.log("\n--- Итог ---");
    console.log(`Проверено запросов: ${results.length}`);
    console.log(`Занято (хотя бы в одном источнике): ${takenByAnySource.size}`);
    console.log(`Некорректный формат (invalid): ${invalid.length}`);
    console.log(`Не удалось определить: ${unknown.length}`);
    console.log(`Подтверждённо свободны (все ответы высокой уверенности): ${confirmedFree.length}`);
    console.log(`Вероятно свободны (есть эвристический ответ Fragment): ${likelyFree.length}`);

    if (confirmedFree.length > 0) {
      console.log("\nПодтверждённо свободные:");
      for (const username of confirmedFree) {
        console.log(`  ${username}`);
      }
    }

    if (likelyFree.length > 0) {
      console.log(
        "\nВероятно свободные: Telegram подтвердил доступность, а Fragment не нашёл признаков занятости:",
      );
      for (const username of likelyFree) {
        console.log(`  ${username} — Fragment: эвристика, проверьте карточку вручную`);
      }
    }

    const availableForEstimate = [
      ...confirmedFree,
      ...likelyFree,
      ...partiallyChecked.map((item) => item.username),
    ];

    let priceEstimates = new Map<string, PricePrediction>();
    if (availableForEstimate.length > 0) {
      console.log(
        `\nЧтобы добавить в избранное: npm run favorites -- add <username> --source telegram`,
      );

      if (raw.estimatePrice) {
        if (!priceModelExists()) {
          console.log(
            "\n⚠️  --estimate-price: модель оценки цены ещё не обучена. Соберите данные " +
              "(npm run collect-sales) и обучите модель (npm run train-price), затем повторите поиск.",
          );
        } else {
          priceEstimates = await estimatePrices(
            availableForEstimate,
            "Примерная оценка цены (обученная модель, ориентируйтесь на порядок величины):",
          );
        }
      }
    }

    if (partiallyChecked.length > 0) {
      console.log(
        "\nСвободны в выбранном источнике; второй источник не проверялся:",
      );
      for (const { username, checkedSources } of partiallyChecked) {
        console.log(`  ${username} — проверено: ${checkedSources.join(", ")}`);
      }
    }

    if (opts.outPath) {
      const freeUsernames = new Set([
        ...confirmedFree,
        ...likelyFree,
        ...partiallyChecked.map((item) => item.username),
      ]);
      const resultsForOutput = showTaken
        ? results
        : results.filter((r) => freeUsernames.has(r.username));
      writeJson(opts.outPath, withPriceEstimates(resultsForOutput, priceEstimates));
      console.log(`\nРезультаты сохранены в ${opts.outPath}`);
    }
  });

program
  .command("collect-sales")
  .description(
    "Собрать историю проданных юзернеймов с Fragment для обучения моделей цены и генерации.",
  )
  .option("--pages <n>", "сколько market views/страниц листинга обойти", "3")
  .option("--delay <ms>", "пауза между страницами, мс", "2000")
  .option("--debug", "сохранять сырой HTML в ./debug для калибровки", false)
  .option("--base-url <url>", "свой адрес листинга, если предполагаемый по умолчанию не подойдёт")
  .action(async (raw) => {
    const collected = await collectSoldHistory({
      maxPages: integerOption(raw.pages, "--pages", 1, 50),
      delayMs: integerOption(raw.delay, "--delay", 0, 60_000),
      debug: Boolean(raw.debug),
      baseUrl: raw.baseUrl,
    });

    if (collected.length === 0) {
      console.log(
        "\nНичего не собрано. Скорее всего, разметка страницы отличается от предполагаемой " +
          "(или адрес по умолчанию не тот) — запустите с --debug и посмотрите HTML в ./debug/.",
      );
      process.exitCode = 1;
      return;
    }

    const merged = mergeSoldHistory(loadSoldHistory(), collected);
    saveSoldHistory(merged);
    console.log(
      `\nСобрано за этот запуск: ${collected.length}. Всего в data/sold-history.json: ${merged.length}.`,
    );
  });

program
  .command("train-price")
  .description("Обучить модель оценки цены на собранной истории продаж (data/sold-history.json)")
  .option("--epochs <n>", "число эпох обучения", "200")
  .action((raw) => {
    trainPriceModel({ epochs: integerOption(raw.epochs, "--epochs", 1, 5000) });
  });

program
  .command("train-generator")
  .description(
    "Обучить нейросеть-генератор юзернеймов на избранном + собранной истории продаж (с учётом цены) + словаре",
  )
  .option("--epochs <n>", "число эпох обучения", "100")
  .option(
    "--dictionary-words <n>",
    "сколько слов словаря подмешать как образец фонотактики (0 — отключить)",
    "1200",
  )
  .action((raw) => {
    trainGeneratorModel({
      epochs: integerOption(raw.epochs, "--epochs", 1, 5000),
      dictionarySample: integerOption(raw.dictionaryWords, "--dictionary-words", 0, 8742),
    });
  });

program
  .command("generate-ai")
  .description("Сгенерировать кандидатов обученной нейросетью (npm run train-generator) вместо слогового генератора")
  .option("--count <n>", "сколько кандидатов сгенерировать", "20")
  .option("--min-length <n>", "минимальная длина", "5")
  .option("--max-length <n>", "максимальная длина", "8")
  .option("--temperature <t>", "0 = всегда самый вероятный символ, выше — разнообразнее/случайнее", "0.8")
  .option("--source <source>", "telegram | fragment | both — проверить доступность (по умолчанию не проверяет)")
  .option("--estimate-price", "оценить цену обученной моделью (npm run train-price)", false)
  .option("--delay <ms>", "пауза между запросами при проверке, мс", "2000")
  .option(
    "--safe-mode",
    "случайная широкая пауза между запросами вместо предсказуемого jitter (снижает риск flood-limit)",
    false,
  )
  .option("--out <path>", "куда сохранить кандидатов/результаты (JSON)")
  .option(
    "--show-taken",
    "включить занятые/некорректные варианты в --out (по умолчанию скрыты)",
    false,
  )
  .action(async (raw) => {
    if (!generatorModelExists()) {
      console.error("Модель генерации не найдена. Сначала обучите её: npm run train-generator");
      process.exit(1);
    }

    const count = integerOption(raw.count, "--count", 1, 1000);
    const minLength = integerOption(raw.minLength, "--min-length", 5, 32);
    const maxLength = integerOption(raw.maxLength, "--max-length", 5, 32);
    const temperature = numberOption(raw.temperature, "--temperature", 0, 3);
    const delayMs = integerOption(raw.delay, "--delay", 0, 60_000);
    const safeMode = Boolean(raw.safeMode);
    if (minLength > maxLength) {
      console.error("--min-length не может быть больше --max-length");
      process.exit(1);
    }
    const candidates = generateWithModel(count, minLength, maxLength, temperature);
    console.log(`Сгенерировано нейросетью: ${candidates.length}\n`);
    if (candidates.length === 0) {
      console.error(
        "Модель не смогла сгенерировать кандидатов с этими параметрами. " +
          "Попробуйте увеличить temperature/диапазон длины или дообучить модель.",
      );
      process.exitCode = 1;
      return;
    }

    if (!raw.source) {
      for (const c of candidates) {
        console.log(`  ${c.username}`);
      }
      let priceEstimates = new Map<string, PricePrediction>();
      if (raw.estimatePrice) {
        if (!priceModelExists()) {
          console.log(
            "\n⚠️  --estimate-price: модель цены ещё не обучена (npm run train-price).",
          );
        } else {
          priceEstimates = await estimatePrices(
            candidates.map((candidate) => candidate.username),
            "Примерная оценка потенциальной цены:",
          );
        }
      }
      if (raw.out) {
        writeJson(raw.out, withPriceEstimates(candidates, priceEstimates));
        console.log(`\nКандидаты сохранены в ${raw.out}`);
      }
      console.log("\nЧтобы сразу проверить доступность — добавьте --source telegram|fragment|both");
      return;
    }

    const source = raw.source as SourceOption;
    if (!["telegram", "fragment", "both"].includes(source)) {
      console.error(`Неверный --source: ${source}`);
      process.exit(1);
    }
    const sourcesToCheck: Source[] = source === "both" ? ["telegram", "fragment"] : [source as Source];

    let telegramClient: Awaited<ReturnType<typeof getClient>> | null = null;
    if (sourcesToCheck.includes("telegram")) {
      telegramClient = await getClient();
    }

    if (safeMode) {
      const range = safeModeRange(delayMs);
      console.log(
        `🛡️  Безопасный режим: пауза между запросами случайная, от ${Math.round(range.minMs / 1000)} ` +
          `до ${Math.round(range.maxMs / 1000)} сек.\n`,
      );
    }

    const results: CheckResult[] = [];
    for (const candidate of candidates) {
      const candidateResults: CheckResult[] = [];
      for (const src of sourcesToCheck) {
        const alreadyRuledOut = candidateResults.some(
          (r) => r.available === false || r.available === "invalid",
        );
        if (alreadyRuledOut) break;

        const result =
          src === "telegram"
            ? await checkTelegramMtproto(candidate.username, telegramClient!)
            : await checkFragment(candidate.username, {});
        candidateResults.push(result);
        results.push(result);
        await sleep(nextDelayMs(delayMs, safeMode));
      }
      console.log(formatCandidateLine(candidate.username, candidateResults));
    }

    if (telegramClient) await disconnectClient();

    const free = candidates
      .map((c) => c.username)
      .filter((u) => {
        const rs = results.filter((r) => r.username === u);
        return rs.length === sourcesToCheck.length && rs.every((r) => r.available === true);
      });

    let priceEstimates = new Map<string, PricePrediction>();
    if (free.length > 0 && raw.estimatePrice) {
      if (!priceModelExists()) {
        console.log(
          "\n⚠️  --estimate-price: модель цены ещё не обучена (npm run train-price).",
        );
      } else {
        priceEstimates = await estimatePrices(free, "Примерная оценка цены:");
      }
    }

    if (raw.out) {
      const resultsForOutput = Boolean(raw.showTaken)
        ? results
        : results.filter((r) => free.includes(r.username));
      writeJson(raw.out, withPriceEstimates(resultsForOutput, priceEstimates));
      console.log(`\nРезультаты сохранены в ${raw.out}`);
    }
  });

program
  .command("login")
  .description(
    "Разовый вход в Telegram под своим аккаунтом (нужен для официальной проверки через account.checkUsername)",
  )
  .action(async () => {
    await runLogin();
  });

const favorites = program.command("favorites").description("Управление избранными юзернеймами");

favorites
  .command("add <username>")
  .description("Добавить юзернейм в избранное")
  .option("--source <source>", "telegram | fragment", "telegram")
  .option("--note <text>", "комментарий")
  .option("--price-ton <amount>", "цена или оценка цены в TON")
  .action((username, raw) => {
    const source = raw.source as Source;
    if (!["telegram", "fragment"].includes(source)) {
      console.error(`Неверный --source: ${source}`);
      process.exit(1);
    }
    const normalized = normalizeUsernameForCli(username, source);
    const price: FavoritePrice | undefined =
      raw.priceTon === undefined
        ? undefined
        : {
            ton: numberOption(raw.priceTon, "--price-ton", 0, 1_000_000_000_000),
          };
    const entry = addFavorite(normalized, source, raw.note, undefined, price);
    const priceLabel = entry.price ? `, ${entry.price.ton} TON` : "";
    console.log(`Добавлено в избранное: ${entry.username} [${entry.source}${priceLabel}]`);
  });

favorites
  .command("remove <username>")
  .description("Удалить юзернейм из избранного")
  .option("--source <source>", "telegram | fragment (если не указано — удалить из всех источников)")
  .action((username, raw) => {
    if (raw.source && !["telegram", "fragment"].includes(raw.source)) {
      console.error(`Неверный --source: ${raw.source}`);
      process.exit(1);
    }
    const normalized = normalizeUsernameForCli(username);
    const removed = removeFavorite(normalized, raw.source);
    console.log(removed > 0 ? `Удалено записей: ${removed}` : "Ничего не найдено.");
  });

favorites
  .command("list")
  .description("Показать избранные юзернеймы")
  .option("--source <source>", "telegram | fragment")
  .action((raw) => {
    if (raw.source && !["telegram", "fragment"].includes(raw.source)) {
      console.error(`Неверный --source: ${raw.source}`);
      process.exit(1);
    }
    const list = listFavorites(raw.source);
    if (list.length === 0) {
      console.log("Избранное пусто.");
      return;
    }
    for (const f of list) {
      const note = f.note ? ` — ${f.note}` : "";
      const price = f.price ? `, ≈${f.price.ton.toFixed(2)} TON` : "";
      console.log(`${f.username} [${f.source}${price}] (добавлено ${f.addedAt})${note}`);
    }
  });

program.parseAsync(process.argv);
