import { jsonError } from "control-shared";
import {
  createDatabase,
  deleteDatabase,
  executeDatabase,
  listDatabases,
} from "control-d1-lifecycle";
import {
  applyMigrations,
  listMigrations,
  migrationStatusEndpoint,
} from "control-d1-migrations";

/**
 * @param {{
 *   request: Request,
 *   env: import("control-d1-lifecycle").D1RuntimeEnv,
 *   method: string,
 *   ns: string,
 *   subPath: string[],
 *   requestId: string,
 * }} args
 */
export async function handle({ request, env, method, ns, subPath, requestId }) {
  if (subPath.length === 1 && subPath[0] === "databases") {
    if (method === "GET") return await listDatabases({ ns, requestId });
    if (method === "POST") return await createDatabase({ request, env, ns, requestId });
    return jsonError(405, "method_not_allowed", "Method not allowed");
  }

  if (subPath.length === 2 && subPath[0] === "databases") {
    if (method === "DELETE") {
      return await deleteDatabase({ env, ns, databaseId: subPath[1], requestId });
    }
    return jsonError(405, "method_not_allowed", "Method not allowed");
  }

  if (subPath.length === 3 && subPath[0] === "databases" && subPath[2] === "query") {
    if (method === "POST") {
      return await executeDatabase({ request, env, ns, databaseId: subPath[1], requestId });
    }
    return jsonError(405, "method_not_allowed", "Method not allowed");
  }

  if (subPath.length === 3 && subPath[0] === "databases" && subPath[2] === "migrations") {
    if (method === "GET") {
      return await listMigrations({ env, ns, databaseId: subPath[1], requestId });
    }
    return jsonError(405, "method_not_allowed", "Method not allowed");
  }

  if (subPath.length === 4 && subPath[0] === "databases" && subPath[2] === "migrations") {
    if (method === "POST" && subPath[3] === "status") {
      return await migrationStatusEndpoint({ request, env, ns, databaseId: subPath[1], requestId });
    }
    if (method === "POST" && subPath[3] === "apply") {
      return await applyMigrations({ request, env, ns, databaseId: subPath[1], requestId });
    }
    return jsonError(405, "method_not_allowed", "Method not allowed");
  }

  return jsonError(404, "not_found", "Not found");
}
