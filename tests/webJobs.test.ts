import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JobManager, type JobSnapshot } from "../src/web/jobs.js";
import { validateJobRequest } from "../src/web/validation.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOB_WORKER = resolve(PROJECT_ROOT, "tests", "fixtures", "jobWorker.mjs");

async function waitForTerminalJob(
  manager: JobManager,
  id: string,
  timeoutMs = 15_000,
): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.get(id);
    assert.ok(snapshot, "job disappeared from the manager");
    if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) {
      return snapshot;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  manager.cancel(id);
  throw new Error(`job did not finish in ${timeoutMs}ms`);
}

async function waitForLog(
  manager: JobManager,
  id: string,
  fragment: string,
  timeoutMs = 5_000,
): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.get(id);
    assert.ok(snapshot, "job disappeared from the manager");
    if (snapshot.logs.some((line) => line.includes(fragment))) return snapshot;
    if (["failed", "cancelled"].includes(snapshot.status)) {
      assert.fail(snapshot.error || snapshot.logs.join("\n"));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`job did not log "${fragment}" in ${timeoutMs}ms`);
}

function fixtureManager(projectRoot: string): JobManager {
  return new JobManager({
    projectRoot,
    cliEntry: JOB_WORKER,
    sourceCli: false,
  });
}

function fixtureJob(
  mode: "fail" | "hold" | "hold-ignore",
): Parameters<JobManager["create"]>[0] {
  return {
    type: "search",
    args: [mode],
    expectsResult: true,
    totalUnits: 1,
  };
}

test("JobManager launches the TypeScript CLI with node --import tsx in dry-run mode", async () => {
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "tg-username-web-jobs-"));
  const previousApiId = process.env.TG_API_ID;
  const previousApiHash = process.env.TG_API_HASH;

  try {
    delete process.env.TG_API_ID;
    delete process.env.TG_API_HASH;
    symlinkSync(
      resolve(PROJECT_ROOT, "node_modules"),
      resolve(isolatedRoot, "node_modules"),
      "junction",
    );

    const manager = new JobManager({
      projectRoot: isolatedRoot,
      cliEntry: resolve(PROJECT_ROOT, "src", "cli.ts"),
      sourceCli: true,
    });
    const request = validateJobRequest({
      type: "search",
      params: {
        source: "both",
        mode: "random",
        minLength: 5,
        maxLength: 6,
        digits: "exclude",
        count: 3,
        delayMs: 250,
        dryRun: true,
      },
    });

    assert.equal(request.expectsResult, true);
    const created = manager.create(request);
    const completed = await waitForTerminalJob(manager, created.id);

    assert.equal(completed.status, "succeeded", completed.error);
    assert.equal(completed.error, undefined);
    assert.ok(Array.isArray(completed.result));
    assert.equal(completed.result.length, 3);
    assert.ok(
      completed.logs.some((line) =>
        line.includes("Сгенерировано уникальных кандидатов: 3")),
      completed.logs.join("\n"),
    );
    assert.equal(existsSync(resolve(isolatedRoot, ".env")), false);
    assert.equal(existsSync(resolve(isolatedRoot, ".tg-session")), false);
    assert.equal(existsSync(resolve(isolatedRoot, "favorites.json")), false);
    assert.equal(existsSync(resolve(isolatedRoot, "data")), false);
  } finally {
    if (previousApiId === undefined) delete process.env.TG_API_ID;
    else process.env.TG_API_ID = previousApiId;
    if (previousApiHash === undefined) delete process.env.TG_API_HASH;
    else process.env.TG_API_HASH = previousApiHash;
    const isolatedModules = resolve(isolatedRoot, "node_modules");
    try {
      if (existsSync(isolatedModules)) unlinkSync(isolatedModules);
    } catch {
      // Best effort only; the directory lives under the OS temp root.
    }
    try {
      rmSync(isolatedRoot, { recursive: true, force: true });
    } catch {
      // The child process/loader can retain handles briefly on Windows.
    }
  }
});

test("JobManager cancels running and queued jobs and removes partial results", async () => {
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "tg-username-web-cancel-"));
  const manager = fixtureManager(isolatedRoot);

  try {
    const running = manager.create(fixtureJob("hold"));
    await waitForLog(manager, running.id, "READY hold");
    const runningResult = resolve(
      isolatedRoot,
      ".runtime",
      "jobs",
      `${running.id}.json`,
    );
    assert.equal(existsSync(runningResult), true);

    const queued = manager.create(fixtureJob("hold"));
    assert.equal(manager.get(queued.id)?.status, "queued");
    const queuedResult = resolve(
      isolatedRoot,
      ".runtime",
      "jobs",
      `${queued.id}.json`,
    );
    writeFileSync(queuedResult, "[]", "utf-8");

    assert.equal(manager.cancel(queued.id)?.status, "cancelled");
    assert.equal(existsSync(queuedResult), false);

    assert.equal(manager.cancel(running.id)?.status, "running");
    const cancelled = await waitForTerminalJob(manager, running.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(existsSync(runningResult), false);
    assert.equal(manager.getActive(), undefined);
  } finally {
    await manager.dispose();
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("JobManager dispose stops an uncooperative worker, cancels its queue, and becomes immutable", async () => {
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "tg-username-web-dispose-"));
  const manager = fixtureManager(isolatedRoot);

  try {
    const running = manager.create(fixtureJob("hold-ignore"));
    await waitForLog(manager, running.id, "READY hold-ignore");
    const queued = manager.create(fixtureJob("hold"));
    const queuedResult = resolve(
      isolatedRoot,
      ".runtime",
      "jobs",
      `${queued.id}.json`,
    );
    writeFileSync(queuedResult, "[]", "utf-8");

    await manager.dispose(6_000);

    assert.equal(manager.get(running.id)?.status, "cancelled");
    assert.equal(manager.get(queued.id)?.status, "cancelled");
    assert.equal(manager.getActive(), undefined);
    assert.equal(
      existsSync(resolve(isolatedRoot, ".runtime", "jobs", `${running.id}.json`)),
      false,
    );
    assert.equal(existsSync(queuedResult), false);
    assert.throws(
      () => manager.create(fixtureJob("hold")),
      /остановлена|остановлен/,
    );
  } finally {
    await manager.dispose();
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("JobManager removes a result file written by a failed process", async () => {
  const isolatedRoot = mkdtempSync(resolve(tmpdir(), "tg-username-web-fail-"));
  const manager = fixtureManager(isolatedRoot);

  try {
    const created = manager.create(fixtureJob("fail"));
    const completed = await waitForTerminalJob(manager, created.id);
    assert.equal(completed.status, "failed");
    assert.equal(
      existsSync(resolve(isolatedRoot, ".runtime", "jobs", `${created.id}.json`)),
      false,
    );
  } finally {
    await manager.dispose();
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});
