import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** @param {string} prefix */
export function makeTempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** @param {string} dir */
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTempDir(prefix, fn) {
  const dir = makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
  }
}
