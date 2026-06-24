#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "licenses", "third-party");
const RUST_SERVICES_OUT_DIR = path.join(OUT_DIR, "rust-services");
const SUPERVISOR_OUT_DIR = path.join(OUT_DIR, "supervisor");
const WORKERD_OUT_DIR = path.join(OUT_DIR, "workerd");
const RUST_MANIFEST = path.join(ROOT, "rust", "Cargo.toml");
const PACKAGE_LOCK = path.join(ROOT, "package-lock.json");

const LICENSE_FILE_RE = /^(?:licen[sc]e|copying|copyright|notice|authors)(?:[-_.].*)?$/iu;

/**
 * @typedef {{ version?: unknown, license?: unknown }} PackageLockPackage
 * @typedef {{ packages?: Record<string, PackageLockPackage> }} PackageLock
 * @typedef {{
 *   name: string,
 *   version: string,
 *   source?: string | null,
 *   license?: string | null,
 *   license_file?: string | null,
 *   manifest_path: string,
 *   repository?: string | null,
 *   homepage?: string | null,
 * }} CargoPackage
 * @typedef {{ packages: CargoPackage[] }} CargoMetadata
 * @typedef {{ title: string, outputDir: string, outputFile: string, roots: string[] }} RustBundle
 */

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(RUST_SERVICES_OUT_DIR, { recursive: true });
mkdirSync(SUPERVISOR_OUT_DIR, { recursive: true });
mkdirSync(WORKERD_OUT_DIR, { recursive: true });

/** @param {string} value */
function normalizeText(value) {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trimEnd();
}

/**
 * @param {PackageLock} lock
 * @param {string} packageName
 */
function packageLockPackage(lock, packageName) {
  return lock.packages?.[`node_modules/${packageName}`];
}

function writeWorkerdNotice() {
  /** @type {PackageLock} */
  const lock = JSON.parse(readFileSync(PACKAGE_LOCK, "utf8"));
  const pkg = packageLockPackage(lock, "workerd");
  if (!pkg) {
    throw new Error("package-lock.json does not contain a workerd package entry");
  }
  const version = String(pkg.version ?? "unknown");
  const license = String(pkg.license ?? "Apache-2.0");
  const lines = [
    "workerd binary",
    "",
    `Package: workerd ${version}`,
    "Source: https://github.com/cloudflare/workerd",
    `License: ${license}`,
    "",
    "The workerd npm wrapper selects the platform-specific Cloudflare-published",
    "binary package during npm install, such as @cloudflare/workerd-linux-64",
    "or @cloudflare/workerd-linux-arm64. WDL Docker images copy that resolved",
    "binary into the runtime image.",
    "",
    "The Apache-2.0 license text is included in the source repository root",
    "LICENSE and in /usr/share/licenses/wdl/LICENSE inside WDL images.",
    "",
  ];
  writeFileSync(path.join(WORKERD_OUT_DIR, "workerd.txt"), lines.join("\n"));
}

/** @returns {CargoMetadata} */
function cargoMetadata() {
  const stdout = execFileSync(
    "cargo",
    ["metadata", "--manifest-path", RUST_MANIFEST, "--locked", "--format-version", "1"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

/** @param {string} rootPackage */
function cargoTreePackageKeys(rootPackage) {
  const stdout = execFileSync(
    "cargo",
    [
      "tree",
      "--manifest-path",
      RUST_MANIFEST,
      "--locked",
      "-p",
      rootPackage,
      "--edges",
      "normal",
      "--prefix",
      "none",
      "--format",
      "{p}",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const keys = new Set();
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+v(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/u.exec(line.trim());
    if (match && match[1] !== rootPackage) {
      keys.add(`${match[1]} ${match[2]}`);
    }
  }
  return keys;
}

/** @param {string[]} rootPackages */
function rustPackageKeysForRoots(rootPackages) {
  const keys = new Set();
  for (const rootPackage of rootPackages) {
    for (const key of cargoTreePackageKeys(rootPackage)) {
      keys.add(key);
    }
  }
  return keys;
}

/** @param {CargoPackage} pkg */
function licenseFilesForPackage(pkg) {
  const manifestDir = path.dirname(pkg.manifest_path);
  const files = new Set();
  if (pkg.license_file) {
    const licenseFile = path.isAbsolute(pkg.license_file)
      ? pkg.license_file
      : path.join(manifestDir, pkg.license_file);
    if (existsSync(licenseFile)) files.add(licenseFile);
  }
  for (const entry of readdirSync(manifestDir, { withFileTypes: true })) {
    if (entry.isFile() && LICENSE_FILE_RE.test(entry.name)) {
      files.add(path.join(manifestDir, entry.name));
    }
  }
  return [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** @param {RustBundle} bundle */
function writeRustCrateNotices(bundle) {
  const metadata = cargoMetadata();
  const includedKeys = rustPackageKeysForRoots(bundle.roots);
  const packages = metadata.packages
    .filter((pkg) => String(pkg.source ?? "").startsWith("registry+"))
    .filter((pkg) => includedKeys.has(`${pkg.name} ${pkg.version}`))
    .sort((a, b) => `${a.name} ${a.version}`.localeCompare(`${b.name} ${b.version}`));

  const lines = [
    bundle.title,
    "",
    `Root packages: ${bundle.roots.join(", ")}`,
    "Generated from `cargo tree --edges normal`, `cargo metadata --locked`,",
    "and crate source license files.",
    "Regenerate with `npm run build:third-party-licenses` after Rust dependency changes.",
    "",
    `Package count: ${packages.length}`,
    "",
  ];

  for (const pkg of packages) {
    lines.push("=".repeat(78));
    lines.push(`${pkg.name} ${pkg.version}`);
    lines.push(`Source: ${pkg.source}`);
    lines.push(`License: ${pkg.license ?? "see license file"}`);
    if (pkg.repository) lines.push(`Repository: ${pkg.repository}`);
    if (pkg.homepage) lines.push(`Homepage: ${pkg.homepage}`);

    const licenseFiles = licenseFilesForPackage(pkg);
    if (licenseFiles.length === 0) {
      lines.push("");
      lines.push("No license file was found in the crate source checkout.");
      lines.push("Use the license metadata above for this package.");
      lines.push("");
      continue;
    }

    for (const file of licenseFiles) {
      lines.push("");
      lines.push(`--- BEGIN ${path.basename(file)} ---`);
      lines.push(normalizeText(readFileSync(file, "utf8")));
      lines.push(`--- END ${path.basename(file)} ---`);
    }
    lines.push("");
  }

  writeFileSync(path.join(bundle.outputDir, bundle.outputFile), lines.join("\n"));
}

writeWorkerdNotice();
writeRustCrateNotices({
  title: "Rust service crate license bundle",
  outputDir: RUST_SERVICES_OUT_DIR,
  outputFile: "rust-services-crates.txt",
  roots: ["redis-proxy", "scheduler", "workflows"],
});
writeRustCrateNotices({
  title: "Supervisor crate license bundle",
  outputDir: SUPERVISOR_OUT_DIR,
  outputFile: "supervisor-crates.txt",
  roots: ["supervisor"],
});
