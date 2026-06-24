import assert from "node:assert/strict";
import { test } from "node:test";

import { rewriteCloudflareWorkflowsImports } from "../../runtime/load/module-rewrite.js";

const LOCAL_WORKFLOWS_SPECIFIER = "../_wdl-cloudflare-workflows.js";
const TARGET_SPECIFIER = "cloudflare:workflows";

/** @param {string} source @param {string} expected */
function segment(source, expected = source) {
  return { source, expected };
}

/** @param {string} source */
function rewritesToLocal(source) {
  return segment(source, source.replaceAll(TARGET_SPECIFIER, LOCAL_WORKFLOWS_SPECIFIER));
}

const REWRITE_SEGMENTS = [
  () => rewritesToLocal(`import "${TARGET_SPECIFIER}";`),
  () => rewritesToLocal(`import/*side-effect*/"${TARGET_SPECIFIER}";`),
  () => rewritesToLocal(`import { WorkflowEntrypoint } from "${TARGET_SPECIFIER}";`),
  () => rewritesToLocal(`import {\n  NonRetryableError as WorkflowError,\n} from "${TARGET_SPECIFIER}";`),
  () => rewritesToLocal(`import { "WorkflowEntrypoint" as QuotedEntrypoint } from "${TARGET_SPECIFIER}";`),
  () => rewritesToLocal(`export { WorkflowEntrypoint } from "${TARGET_SPECIFIER}";`),
  () => rewritesToLocal(`export { WorkflowEntrypoint as PreservedEntrypoint } from "${TARGET_SPECIFIER}";`),
  () => rewritesToLocal(`const dynamicModule = import("${TARGET_SPECIFIER}");`),
  () => rewritesToLocal(`const dynamicWithInnerComment = import(/* @vite-ignore */ "${TARGET_SPECIFIER}");`),
  () => rewritesToLocal(`const templateDynamic = \`${"${"}import("${TARGET_SPECIFIER}")}\`;`),
];

const UNTOUCHED_SEGMENTS = [
  () => segment(`const stringLiteral = "import { X } from \\"${TARGET_SPECIFIER}\\"";`),
  () => segment(`const singleQuoted = 'export { X } from "${TARGET_SPECIFIER}"';`),
  () => segment(`const rawTemplate = \`import("${TARGET_SPECIFIER}")\`;`),
  () => segment(`// import { X } from "${TARGET_SPECIFIER}";`),
  () => segment(`/* export { X } from "${TARGET_SPECIFIER}"; */`),
  () => segment(`const regexLiteral = /import\\("${TARGET_SPECIFIER}"\\)/g;`),
  () => segment(`loader.import("${TARGET_SPECIFIER}");`),
  () => segment(`loader./* comment */import("${TARGET_SPECIFIER}");`),
  () => segment(`import.meta.resolve("${TARGET_SPECIFIER}");`),
  () => segment(`class PrivateImport { #import(v) { return v; } m() { return this.#import("${TARGET_SPECIFIER}"); } }`),
  () => segment(`const propertyNamedFrom = { from: "${TARGET_SPECIFIER}" };`),
  () => segment(`function f(from = "${TARGET_SPECIFIER}") { return from; }`),
];

const SEPARATORS = ["\n", "\n;\n", "\nif (true) {}\n", "\ntry {} catch {}\n", "\nclass Boundary {}\n"];

// Deterministic property-style coverage for tokenizer states that are too easy to
// under-cover with one hand-written mega fixture.
/** @param {number} seed */
function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** @template T @param {() => number} random @param {T[]} values @returns {T} */
function choose(random, values) {
  return values[Math.floor(random() * values.length)];
}

/** @param {string} source */
function rewriteModuleSource(source) {
  const workerCode = { modules: { "src/fuzz.js": source } };
  rewriteCloudflareWorkflowsImports(workerCode);
  return /** @type {string} */ (workerCode.modules["src/fuzz.js"]);
}

test("module rewrite fuzz: fixed seed specifier positions only", () => {
  for (let seed = 1; seed <= 512; seed += 1) {
    const random = createPrng(seed);
    const parts = [];
    const expected = [];
    for (let i = 0; i < 24; i += 1) {
      const factorySet = random() < 0.46 ? REWRITE_SEGMENTS : UNTOUCHED_SEGMENTS;
      const { source, expected: expectedSource } = choose(random, factorySet)();
      const separator = choose(random, SEPARATORS);
      parts.push(source, separator);
      expected.push(expectedSource, separator);
    }
    const source = parts.join("");
    const rewritten = rewriteModuleSource(source);
    assert.equal(rewritten, expected.join(""), `rewrite mismatch for seed ${seed}`);
    assert.equal(rewriteModuleSource(rewritten), rewritten, `rewrite must be idempotent for seed ${seed}`);
  }
});

test("module rewrite leaves non-specifier workflow occurrences untouched", () => {
  const source = [
    "export default { fetch() { return new Response('ok'); } };",
    `const text = "cloudflare:workflows";`,
    `const regex = /cloudflare:workflows/;`,
  ].join("\n");
  assert.equal(rewriteModuleSource(source), source);
});

test("module rewrite fast path leaves modules without target text untouched", () => {
  const source = [
    "import { WorkerEntrypoint } from \"cloudflare:workers\";",
    "export default { fetch() { return new Response('ok'); } };",
  ].join("\n");
  assert.equal(rewriteModuleSource(source), source);
});
