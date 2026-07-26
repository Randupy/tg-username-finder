import {
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Записывает файл через временный соседний файл и атомарное переименование.
 * Так прерванное обучение или закрытие веб-приложения не оставит половину JSON.
 */
export function writeTextAtomic(path: string, contents: string, mode?: number): void {
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  mkdirSync(parent, { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const tempPath = `${absolutePath}.${process.pid}.${suffix}.tmp`;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf-8",
      ...(mode ? { mode } : {}),
    });
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Временный файл мог не успеть создаться или уже быть переименован.
    }
    throw error;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
