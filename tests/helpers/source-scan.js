// Kept conservative — not full JS parsers, only enough for repo-wide
// grep-style style-contract assertions.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULT_JS_IGNORE_DIRS = new Set([".deploy-dist", ".wrangler", "node_modules"]);

/** @param {string} rel */
export function repoPath(rel) {
  return path.join(ROOT, rel);
}

/** @param {string} rel */
export function readRepoFile(rel) {
  return readFileSync(repoPath(rel), "utf8");
}

/** @param {string} dir */
export function jsFiles(dir) {
  return jsFilesIn(repoPath(dir)).map((file) => path.relative(ROOT, file));
}

/**
 * @param {string} dir
 * @param {{ extensions: string[], ignoreDirs?: Set<string> }} options
 * @returns {string[]}
 */
export function sourceFiles(dir, options) {
  return sourceFilesIn(repoPath(dir), options).map((file) => path.relative(ROOT, file));
}

/**
 * @param {string} dir
 * @param {{ ignoreDirs?: Set<string> }} [options]
 * @returns {string[]}
 */
export function jsFilesIn(dir, options = {}) {
  return sourceFilesIn(dir, { ...options, extensions: [".js"] });
}

/**
 * @param {string} dir
 * @param {{ extensions: string[], ignoreDirs?: Set<string> }} options
 * @returns {string[]}
 */
export function sourceFilesIn(dir, options) {
  const ignoreDirs = new Set([...DEFAULT_JS_IGNORE_DIRS, ...(options.ignoreDirs || [])]);
  const extensions = new Set(options.extensions);
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoreDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFilesIn(full, options));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Repo-relative `.rs` files under `dir`, skipping Cargo `target/` build output.
 * @param {string} dir
 * @returns {string[]}
 */
export function rustFiles(dir) {
  /** @type {(abs: string) => string[]} */
  const walk = (abs) => {
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === "target") continue;
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile() && entry.name.endsWith(".rs")) out.push(full);
    }
    return out;
  };
  return walk(repoPath(dir)).map((file) => path.relative(ROOT, file));
}

/** @param {string} source */
export function withoutLineComments(source) {
  return source.split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}
