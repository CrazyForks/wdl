import {
  jsonResponse,
  jsonError,
  requireControlLog,
  requireControlRedis,
} from "control-shared";
import {
  invalidSecretMutationKeyResponse,
  readEncryptedSecretPutValue,
} from "control-handlers-secret-put";

/**
 * @param {{
 *   request: Request,
 *   env: Record<string, unknown>,
 *   method: string,
 *   nsName: string,
 *   secretKey?: string,
 *   requestId: string,
 * }} args
 */
export async function handle({ request, env, method, nsName, secretKey, requestId }) {
  const redis = requireControlRedis();
  const log = requireControlLog();
  const nsSecretsKey = `secrets:${nsName}`;

  if (method === "GET" && secretKey === undefined) {
    const keys = await redis.hKeys(nsSecretsKey);
    return jsonResponse(200, { namespace: nsName, keys: keys.toSorted() });
  }
  if (method === "PUT" && secretKey !== undefined) {
    const invalidKey = invalidSecretMutationKeyResponse(secretKey);
    if (invalidKey) return invalidKey;
    const put = await readEncryptedSecretPutValue({
      request,
      env,
      hashKey: nsSecretsKey,
      fieldName: secretKey,
    });
    if ("response" in put) return put.response;
    const encrypted = put.encrypted;
    await redis.hSet(nsSecretsKey, secretKey, encrypted);
    log("info", "ns_secret_set", { request_id: requestId, namespace: nsName, key: secretKey });
    return jsonResponse(200, {
      namespace: nsName,
      key: secretKey,
      set: true,
      note: "effect on next natural cold-load (new deploy / runtime recycle)",
    });
  }
  if (method === "DELETE" && secretKey !== undefined) {
    const invalidKey = invalidSecretMutationKeyResponse(secretKey);
    if (invalidKey) return invalidKey;
    const removed = Number(await redis.hDel(nsSecretsKey, secretKey)) > 0;
    log("info", "ns_secret_deleted", {
      request_id: requestId,
      namespace: nsName,
      key: secretKey,
      existed: removed,
    });
    return jsonResponse(200, { namespace: nsName, key: secretKey, deleted: removed });
  }
  return jsonError(405, "method_not_allowed", "Method not allowed for /secrets");
}
