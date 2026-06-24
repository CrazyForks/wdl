import { spawn } from "node:child_process";

/** @param {NodeJS.ReadableStream} src @param {NodeJS.WritableStream} dst @param {string} prefix */
function pipeWithPrefix(src, dst, prefix) {
  let buf = "";
  src.setEncoding("utf8");
  src.on("data", (chunk) => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      dst.write(`${prefix}${buf.slice(0, nl)}\n`);
      buf = buf.slice(nl + 1);
    }
  });
  src.on("end", () => {
    if (buf.length) dst.write(`${prefix}${buf}\n`);
  });
}

const tasks = process.argv.slice(2);
if (tasks.length === 0) {
  process.stderr.write("usage: run-parallel.js <npm-script>...\n");
  process.exit(2);
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const procs = tasks.map((task) => {
  const child = spawn(npmCmd, ["run", "-s", task], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${task}] `;
  pipeWithPrefix(child.stdout, process.stdout, prefix);
  pipeWithPrefix(child.stderr, process.stderr, prefix);
  return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
});

const codes = await Promise.all(procs);
const failure = codes.find((c) => c !== 0);
process.exit(failure ?? 0);
