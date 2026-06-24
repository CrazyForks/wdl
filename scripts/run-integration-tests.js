import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseShardCount, runPooled } from "./_integration-pool.js";
import { assertWdlCliAvailable } from "./integration-environment.js";
import {
  DEFAULT_INTEGRATION_DURATIONS_FILE,
  hasCliIntegrationMarker,
  prioritizeDefaultFiles,
  readIntegrationDurationRecords,
} from "./integration-test-plan.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const INTEGRATION_DIR = path.join(ROOT, "tests/integration");

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(
    `Usage: node scripts/run-integration-tests.js [files...] [node-test-flags...]
Runs tests/integration/*.test.js via the worker-pool runner.
Defaults to all files when no file args are given; non-file args are
forwarded to each per-file 'node --test' invocation.

Env:
  WDL_INTEGRATION_SHARDS                     parallel slots (default 4)
  WDL_INTEGRATION_DURATIONS_FILE             historical duration JSON (default .integration-test-durations.json)
  WDL_INTEGRATION_SKIP_PREPARE=1             skip shared compile/build preflight
  WDL_CLI_BIN                                optional CLI binary override for @wdl-cli-integration tests
                                             (default: wdl on PATH)
  WDL_KEEP_INTEGRATION_STACK=1               keep every slot stack
  WDL_TEARDOWN_INTEGRATION_STACK_ON_FAILURE=1  tear down failed slots too
`
  );
  process.exit(0);
}

// Split caller args into test files vs. extra runner flags.
const explicitFiles = args.filter((a) => a.endsWith(".test.js"));
const extraFlags = args.filter((a) => !a.endsWith(".test.js"));
const durationFile = process.env.WDL_INTEGRATION_DURATIONS_FILE || DEFAULT_INTEGRATION_DURATIONS_FILE;

const files = explicitFiles.length
  ? explicitFiles.map((f) => path.relative(ROOT, path.resolve(f)))
  : prioritizeDefaultFiles(
      readdirSync(INTEGRATION_DIR)
        .filter((name) => name.endsWith(".test.js"))
        .toSorted(),
      { durationRecords: readIntegrationDurationRecords(durationFile) }
    ).map((name) => path.relative(ROOT, path.join(INTEGRATION_DIR, name)));

const shardCount = parseShardCount("WDL_INTEGRATION_SHARDS", 4);
const includesCliIntegration = files.some((file) =>
  hasCliIntegrationMarker(readFileSync(path.join(ROOT, file), "utf8"))
);
if (includesCliIntegration) assertWdlCliAvailable();

const code = await runPooled({
  files,
  shardCount,
  projectPrefix: "wdl-it",
  basePort: 18080,
  s3PortBase: 29500,
  durationFile,
  testArgs: [
    "--test",
    "--test-reporter=spec",
    "--test-timeout=360000",
    "--test-concurrency=1",
    ...extraFlags,
  ],
});

process.exit(code);
