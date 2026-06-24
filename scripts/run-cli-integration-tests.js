import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseShardCount, runPooled } from "./_integration-pool.js";
import { assertWdlCliAvailable } from "./integration-environment.js";
import { CLI_INTEGRATION_MARKER, hasCliIntegrationMarker } from "./integration-test-plan.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const INTEGRATION_DIR = path.join(ROOT, "tests/integration");
const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(
    "Usage: node scripts/run-cli-integration-tests.js [--list] [--match <pattern>]\n" +
    `Runs tests/integration/*.test.js files marked with ${CLI_INTEGRATION_MARKER}.\n` +
    "Set WDL_INTEGRATION_SKIP_PREPARE=1 to skip the shared compile/build preflight.\n" +
    "Set WDL_CLI_BIN to override the wdl command found on PATH."
  );
  process.exit(0);
}

const matchArgIndex = args.indexOf("--match");
const matchPattern = matchArgIndex >= 0 ? args[matchArgIndex + 1] : null;

if (matchArgIndex >= 0 && !matchPattern) {
  console.error("error: --match requires a pattern");
  process.exit(1);
}

let tests = readdirSync(INTEGRATION_DIR)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(INTEGRATION_DIR, name))
  .filter((file) => hasCliIntegrationMarker(readFileSync(file, "utf8")))
  .toSorted()
  .map((file) => path.relative(ROOT, file));

if (tests.length === 0) {
  console.error(`error: no integration tests marked with ${CLI_INTEGRATION_MARKER}`);
  process.exit(1);
}

if (matchPattern) {
  tests = tests.filter((file) => file.includes(matchPattern));
  if (tests.length === 0) {
    console.error(`error: no marked CLI integration tests match ${JSON.stringify(matchPattern)}`);
    process.exit(1);
  }
}

if (args.includes("--list")) {
  for (const file of tests) console.log(file);
  process.exit(0);
}

assertWdlCliAvailable();

const shardCount = parseShardCount("WDL_INTEGRATION_CLI_SHARDS", 2);

const code = await runPooled({
  files: tests,
  shardCount,
  // Distinct project prefix + port range so it can run alongside test:integration.
  projectPrefix: "wdl-it-cli",
  basePort: 18090,
  s3PortBase: 29510,
  testArgs: [
    "--test",
    "--test-reporter=spec",
    "--test-timeout=180000",
    "--test-concurrency=1",
  ],
});

process.exit(code);
