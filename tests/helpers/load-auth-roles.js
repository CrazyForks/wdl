import {
  applyModuleReplacements,
  freshModuleDataUrl,
  readRepositoryFile,
  repositoryFileUrl,
} from "./load-shared-module.js";

const SHARED_NS_URL = repositoryFileUrl("shared/ns-pattern.js");

/**
 * Compile shared/auth-roles.js with optional ROLES patch and return both the
 * data: URL (for downstream loaders to chain rewrites against) and the
 * imported module. `rolesPatch` merges into the baseline ROLES table; it does
 * not replace it.
 *
 * @param {{ rolesPatch?: Record<string, unknown> }} [opts]
 */
export async function compileSharedAuthRoles(opts = {}) {
  const { rolesPatch } = opts;
  let src = applyModuleReplacements(readRepositoryFile("shared/auth-roles.js"), [
    [/from "shared-ns-pattern"/g, `from ${JSON.stringify(SHARED_NS_URL)}`],
  ]);
  if (rolesPatch && typeof rolesPatch === "object") {
    src += `\n;{\n  const __patch = ${JSON.stringify(rolesPatch)};\n  for (const [k, v] of Object.entries(__patch)) {\n    ROLES[k] = v;\n  }\n}\n`;
  }
  const sharedAuthRolesUrl = freshModuleDataUrl(src);
  const sharedAuthRoles = await import(sharedAuthRolesUrl);
  return { sharedAuthRolesUrl, sharedAuthRoles };
}
