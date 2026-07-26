import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobType, ValidatedJob } from "./validation.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobProgress {
  current: number;
  total: number;
  label: string;
}

export interface JobSnapshot {
  id: string;
  type: JobType;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: JobProgress;
  logs: string[];
  result?: unknown;
  error?: string;
}

interface InternalJob extends JobSnapshot {
  args: string[];
  expectsResult: boolean;
  resultPath?: string;
  process?: ChildProcess;
  cancelRequested?: boolean;
  cancelTimer?: NodeJS.Timeout;
  listeners: Set<(snapshot: JobSnapshot) => void>;
}

export interface JobManagerOptions {
  projectRoot: string;
  cliEntry: string;
  sourceCli: boolean;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function publicSnapshot(job: InternalJob): JobSnapshot {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress ? { ...job.progress } : undefined,
    logs: [...job.logs],
    result: job.result,
    error: job.error,
  };
}

export class JobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private readonly runtimeDir: string;
  private runningId: string | null = null;
  private activeCompletion: Promise<void> | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly options: JobManagerOptions) {
    this.runtimeDir = resolve(options.projectRoot, ".runtime", "jobs");
    mkdirSync(this.runtimeDir, { recursive: true });
  }

  create(validated: ValidatedJob): JobSnapshot {
    if (this.disposed) throw new Error("Очередь задач уже остановлена");
    this.trimHistory();
    const id = randomUUID();
    const resultPath = validated.expectsResult
      ? resolve(this.runtimeDir, `${id}.json`)
      : undefined;
    const args = [...validated.args];
    if (resultPath) args.push("--out", resultPath);

    const job: InternalJob = {
      id,
      type: validated.type,
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: validated.totalUnits
        ? { current: 0, total: validated.totalUnits, label: "В очереди" }
        : undefined,
      logs: ["Задача добавлена в очередь"],
      args,
      expectsResult: validated.expectsResult,
      resultPath,
      listeners: new Set(),
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.notify(job);
    void this.runNext();
    return publicSnapshot(job);
  }

  get(id: string): JobSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? publicSnapshot(job) : undefined;
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicSnapshot);
  }

  getActive(): JobSnapshot | undefined {
    if (this.runningId) return this.get(this.runningId);
    const queued = this.queue[0];
    return queued ? this.get(queued) : undefined;
  }

  subscribe(id: string, listener: (snapshot: JobSnapshot) => void): (() => void) | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.listeners.add(listener);
    listener(publicSnapshot(job));
    return () => job.listeners.delete(listener);
  }

  cancel(id: string): JobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!["queued", "running"].includes(job.status)) return publicSnapshot(job);

    if (job.status === "queued") {
      const index = this.queue.indexOf(id);
      if (index >= 0) this.queue.splice(index, 1);
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.logs.push("Задача отменена до запуска");
      if (job.progress) job.progress.label = "Отменено";
      this.cleanupResult(job);
      this.notify(job);
      return publicSnapshot(job);
    }

    job.cancelRequested = true;
    job.logs.push("Останавливаем задачу…");
    if (job.progress) job.progress.label = "Остановка";
    let signalled = false;
    try {
      signalled = job.process?.kill() ?? false;
    } catch (error) {
      job.logs.push(
        `Не удалось отправить сигнал остановки: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!signalled) {
      job.logs.push("Процесс не подтвердил мягкую остановку; будет выполнена принудительная.");
    }
    if (job.cancelTimer) clearTimeout(job.cancelTimer);
    job.cancelTimer = setTimeout(() => {
      if (job.status !== "running") return;
      try {
        const forced = job.process?.kill("SIGKILL") ?? false;
        job.logs.push(
          forced
            ? "Задача не завершилась вовремя — отправлена принудительная остановка."
            : "Не удалось подтвердить принудительную остановку процесса.",
        );
      } catch (error) {
        job.logs.push(
          `Ошибка принудительной остановки: ${error instanceof Error ? error.message : error}`,
        );
      }
      this.notify(job);
    }, 3_000);
    job.cancelTimer.unref();
    this.notify(job);
    return publicSnapshot(job);
  }

  dispose(timeoutMs = 5_000): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = this.disposeInternal(timeoutMs);
    }
    return this.disposePromise;
  }

  private async disposeInternal(timeoutMs: number): Promise<void> {
    this.disposed = true;
    for (const id of [...this.queue]) this.cancel(id);
    if (this.runningId) this.cancel(this.runningId);

    const completion = this.activeCompletion;
    if (!completion) return;

    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      completion,
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    if (this.runningId) {
      const running = this.jobs.get(this.runningId);
      try {
        running?.process?.kill("SIGKILL");
      } catch {
        // Shutdown продолжится: родительский процесс всё равно завершает работу.
      }
    }
  }

  private notify(job: InternalJob): void {
    const snapshot = publicSnapshot(job);
    for (const listener of job.listeners) listener(snapshot);
  }

  private trimHistory(): void {
    if (this.jobs.size < 30) return;
    const completed = [...this.jobs.values()]
      .filter((job) => !["queued", "running"].includes(job.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size >= 30 && completed.length > 0) {
      const job = completed.shift()!;
      this.cleanupResult(job);
      this.jobs.delete(job.id);
    }
  }

  private updateProgress(job: InternalJob, line: string): void {
    if (!job.progress) return;

    const epochMatch = line.match(/Эпоха\s+(\d+)/i);
    if (epochMatch && job.type.startsWith("train-")) {
      job.progress.current = Math.min(Number(epochMatch[1]) + 1, job.progress.total);
      job.progress.label = `Эпоха ${job.progress.current} из ${job.progress.total}`;
      return;
    }

    const pageMatch = line.match(/Страница\s+(\d+)/i);
    if (pageMatch && job.type === "collect-sales") {
      job.progress.current = Math.min(Number(pageMatch[1]), job.progress.total);
      job.progress.label = `Страница ${job.progress.current} из ${job.progress.total}`;
      return;
    }

    if (job.type === "search" || job.type === "generate-ai") {
      if (/^[✅❌🚫❓⚠️]\s/u.test(line)) {
        job.progress.current = Math.min(job.progress.current + 1, job.progress.total);
        job.progress.label = `${job.progress.current} из ${job.progress.total}`;
      }
    }
  }

  private addLog(job: InternalJob, rawLine: string, channel: "stdout" | "stderr"): void {
    const line = stripAnsi(rawLine).trimEnd();
    if (!line.trim()) return;
    const prefix = channel === "stderr" ? "Ошибка: " : "";
    job.logs.push(`${prefix}${line}`);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
    this.updateProgress(job, line);
    this.notify(job);
  }

  private attachOutput(
    job: InternalJob,
    stream: NodeJS.ReadableStream | null,
    channel: "stdout" | "stderr",
  ): void {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) this.addLog(job, line, channel);
    });
    stream.on("end", () => {
      if (buffer) this.addLog(job, buffer, channel);
    });
  }

  private loadResult(job: InternalJob): void {
    if (!job.resultPath) return;
    if (!existsSync(job.resultPath)) {
      throw new Error("Задача завершилась без файла результата");
    }
    try {
      job.result = JSON.parse(readFileSync(job.resultPath, "utf-8")) as unknown;
    } finally {
      this.cleanupResult(job);
    }
  }

  private cleanupResult(job: InternalJob): void {
    if (!job.resultPath || !existsSync(job.resultPath)) return;
    try {
      // Путь создаётся только нами внутри .runtime/jobs и не зависит от пользовательского ввода.
      unlinkSync(job.resultPath);
    } catch {
      // Best effort: Windows может коротко удерживать файл завершающегося процесса.
    }
  }

  private async runNext(): Promise<void> {
    if (this.runningId || this.disposed) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job || job.status !== "queued") {
      if (!this.disposed) void this.runNext();
      return;
    }

    this.runningId = job.id;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.logs.push("Задача запущена");
    if (job.progress) job.progress.label = "Запуск";
    this.notify(job);

    const invocation = this.options.sourceCli
      ? ["--import", "tsx", this.options.cliEntry, ...job.args]
      : [this.options.cliEntry, ...job.args];

    const child = spawn(process.execPath, invocation, {
      cwd: this.options.projectRoot,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.process = child;
    this.attachOutput(job, child.stdout, "stdout");
    this.attachOutput(job, child.stderr, "stderr");

    const completion = new Promise<void>((resolveDone) => {
      child.once("error", (error) => {
        job.error = error.message;
      });
      child.once("close", (code, signal) => {
        if (job.cancelTimer) clearTimeout(job.cancelTimer);
        job.cancelTimer = undefined;
        const wasCancelled = job.cancelRequested === true || signal !== null;
        try {
          if (wasCancelled) {
            job.status = "cancelled";
            job.error = undefined;
            job.logs.push("Задача остановлена");
          } else if (code === 0 && !job.error) {
            if (job.expectsResult) this.loadResult(job);
            job.status = "succeeded";
            job.logs.push("Готово");
            if (job.progress) {
              job.progress.current = job.progress.total;
              job.progress.label = "Готово";
            }
          } else {
            job.status = "failed";
            job.error ||= `Процесс завершился с кодом ${code ?? "unknown"}`;
            if (job.progress) job.progress.label = "Ошибка";
          }
        } catch (error) {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
          if (job.progress) job.progress.label = "Ошибка";
        }
        this.cleanupResult(job);
        job.finishedAt = new Date().toISOString();
        job.process = undefined;
        this.notify(job);
        resolveDone();
      });
    });
    this.activeCompletion = completion;
    await completion;
    if (this.activeCompletion === completion) this.activeCompletion = null;

    this.runningId = null;
    if (!this.disposed) void this.runNext();
  }
}
