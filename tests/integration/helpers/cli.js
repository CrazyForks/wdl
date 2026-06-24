import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { ROOT, WDL_CLI_BIN } from "./env.js";

const OFFLINE_WRANGLER_ENV = {
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_SEND_ERROR_REPORTS: "false",
  WRANGLER_HIDE_BANNER: "true",
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  NO_PROXY: "localhost,127.0.0.1,::1,admin.test",
  no_proxy: "localhost,127.0.0.1,::1,admin.test",
};

/** @param {...Record<string, string | undefined>} overlays */
export function integrationChildEnv(...overlays) {
  const env = { ...process.env };
  for (const overlay of overlays) Object.assign(env, overlay);
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

/**
 * Integration shell helper commands are intentionally a small Docker/Node command
 * subset. Keep the parser local so child_process never receives an uncontrolled
 * shell command line.
 * @param {string} cmd
 * @returns {Array<{ value: string, quoted: boolean }>}
 */
function shellWords(cmd) {
  /** @type {Array<{ value: string, quoted: boolean }>} */
  const words = [];
  let current = "";
  let quote = "";
  let started = false;
  let quoted = false;
  const pushCurrent = () => {
    if (!started) return;
    words.push({ value: current, quoted });
    current = "";
    started = false;
    quoted = false;
  };
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else if (quote === "\"" && ch === "\\" && i + 1 < cmd.length) {
        const next = cmd[i + 1];
        if (next === "$" || next === "`" || next === "\"" || next === "\\" || next === "\n") {
          i += 1;
          if (next !== "\n") current += next;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      started = true;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      i += 1;
      started = true;
      current += cmd[i];
      continue;
    }
    started = true;
    current += ch;
  }
  if (quote) throw new Error("unterminated quote in integration command");
  pushCurrent();
  return words;
}

/**
 * @param {Array<{ value: string, quoted: boolean }>} words
 */
function splitEnvAssignments(words) {
  /** @type {Record<string, string>} */
  const env = {};
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (word.quoted) break;
    const match = word.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) break;
    env[match[1]] = match[2];
  }
  return { env, argv: words.slice(index) };
}

/**
 * Model the one shell fallback shape used by integration tests without
 * re-opening arbitrary shell execution.
 * @param {Array<{ value: string, quoted: boolean }>} argv
 */
function splitMissingFallback(argv) {
  const fallbackTail = ["2>/dev/null", "||", "echo", "missing"];
  if (argv.length < fallbackTail.length) return { argv, fallbackOutput: null };
  const tail = argv.slice(-fallbackTail.length);
  if (!tail.every((word, index) => !word.quoted && word.value === fallbackTail[index])) {
    return { argv, fallbackOutput: null };
  }
  return {
    argv: argv.slice(0, -fallbackTail.length),
    fallbackOutput: "missing\n",
  };
}

/**
 * Fail closed on shell syntax that this helper has not explicitly modeled.
 * @param {Array<{ value: string, quoted: boolean }>} argv
 */
function assertSupportedIntegrationSyntax(argv) {
  for (const word of argv) {
    if (word.quoted) continue;
    if (word.value === "||" || word.value === "&&" || word.value === ";" || word.value === "|") {
      throw new Error(`unsupported integration shell syntax: ${word.value}`);
    }
    if (/^(?:\d*)?(?:>>?|<<?)/.test(word.value)) {
      throw new Error(`unsupported integration shell redirection: ${word.value}`);
    }
  }
}

/** @param {string} cmd */
export function parseIntegrationCommandForTest(cmd) {
  const { env, argv: rawArgv } = splitEnvAssignments(shellWords(cmd));
  const { argv, fallbackOutput } = splitMissingFallback(rawArgv);
  assertSupportedIntegrationSyntax(argv);
  return {
    env,
    argv: argv.map((word) => word.value),
    quoted: argv.map((word) => word.quoted),
    fallbackOutput,
  };
}

/**
 * @param {string} program
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string | Buffer, stdio?: any, env?: NodeJS.ProcessEnv }} opts
 * @param {Record<string, string>} cmdEnv
 */
function spawnIntegrationCommand(program, args, opts, cmdEnv) {
  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
  const spawnOptions = {
    cwd: opts.cwd || ROOT,
    stdio: opts.stdio || "pipe",
    encoding: "utf8",
    input: opts.input,
    env: integrationChildEnv(opts.env || {}, cmdEnv),
  };
  if (program === "docker") {
    return spawnSync("docker", args, spawnOptions);
  }
  if (program === process.execPath) {
    return spawnSync(process.execPath, args, spawnOptions);
  }
  throw new Error(`unsupported integration command: ${program}`);
}

/**
 * @param {string} cmd
 * @param {{ cwd?: string, input?: string | Buffer, stdio?: any, env?: NodeJS.ProcessEnv }} [opts]
 */
export function sh(cmd, opts = {}) {
  const { env: cmdEnv, argv: rawArgv } = splitEnvAssignments(shellWords(cmd));
  const { argv, fallbackOutput } = splitMissingFallback(rawArgv);
  assertSupportedIntegrationSyntax(argv);
  const [programToken, ...argTokens] = argv;
  const program = programToken?.value;
  const args = argTokens.map((word) => word.value);
  if (!program) throw new Error("empty integration command");
  const res = spawnIntegrationCommand(program, args, opts, cmdEnv);
  if (res.error) throw res.error;
  if (res.status !== 0 && fallbackOutput != null) {
    return fallbackOutput;
  }
  if (res.status !== 0) {
    throw new Error(`integration command failed (${res.status}): ${(res.stderr || res.stdout || cmd).trim()}`);
  }
  return res.stdout || "";
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string, env?: Record<string, string> }} [opts]
 */
export function runWdlCli(args, opts = {}) {
  return spawnSync(WDL_CLI_BIN, args, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    input: opts.input,
    env: integrationChildEnv(OFFLINE_WRANGLER_ENV, opts.env || {}),
  });
}

/** @param {{ status: number | null, stderr?: string, stdout?: string }} res */
export function assertOk(res) {
  assert.equal(res.status, 0, res.stderr || res.stdout || undefined);
}
