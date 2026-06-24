import { jsonResponse, jsonError, authPolicyResponse, readJsonBody, requireControlLog } from "control-shared";

/**
 * @typedef {{ issue(input: Record<string, unknown>): Promise<{ tokenId: string }>, delegatedIssue(input: Record<string, unknown>): Promise<{ tokenId: string, ns?: string, issueTemplate?: string }>, list(input: Record<string, unknown>): Promise<unknown>, revoke(input: Record<string, unknown>): Promise<{ revoked: unknown }> }} AuthBinding
 * @typedef {"tokens" | "delegatedTokens"} AuthTokenRouteKind
 *
 * @param {{
 *   request: Request,
 *   env: Record<string, unknown> & { AUTH?: AuthBinding },
 *   url: URL,
 *   method: string,
 *   tokenId?: string,
 *   auth: { tokenId: string },
 *   requestId: string,
 *   routeKind?: AuthTokenRouteKind,
 * }} args
 */
export async function handle({ request, env, url, method, tokenId, auth, requestId, routeKind = "tokens" }) {
  const log = requireControlLog();
  if (!env.AUTH) {
    return jsonError(503, "auth_binding_missing", "AUTH binding missing");
  }

  if (routeKind === "delegatedTokens") {
    if (method !== "POST" || tokenId !== undefined) {
      return jsonError(405, "method_not_allowed", "Method not allowed for /auth/delegated-tokens");
    }
    const parsed = await readJsonBody(request, { requireObject: true });
    if (parsed.response) return parsed.response;
    const body = /** @type {Record<string, unknown>} */ (parsed.body);
    for (const field of Object.keys(body)) {
      if (field !== "template") {
        return jsonError(400, "invalid_template_request",
          `${field} is not accepted by delegated issue`);
      }
    }
    try {
      const result = await env.AUTH.delegatedIssue({
        issuerTokenId: auth.tokenId,
        template: body.template,
        requestId,
      });
      log("info", "auth_delegated_token_issued", {
        request_id: requestId,
        token_id: result.tokenId,
        target_ns: result.ns,
        issue_template: result.issueTemplate,
      });
      return jsonResponse(201, result);
    } catch (err) {
      return authPolicyResponse(err, requestId, "delegated_issue");
    }
  }

  if (method === "POST" && tokenId === undefined) {
    const parsed = await readJsonBody(request, { requireObject: true });
    if (parsed.response) return parsed.response;
    const body = /** @type {Record<string, unknown>} */ (parsed.body);
    if (body.issue_templates !== undefined) {
      return jsonError(400, "invalid_template_request",
        "issue_templates is a storage field; use issueTemplates");
    }
    try {
      const result = await env.AUTH.issue({
        kind: body.kind,
        ns: body.ns,
        label: body.label,
        expiresAt: body.expiresAt,
        issueTemplates: body.issueTemplates,
        issuerTokenId: auth.tokenId,
        requestId,
      });
      log("info", "auth_token_issued", {
        request_id: requestId,
        token_id: result.tokenId,
        target_ns: body.ns,
      });
      return jsonResponse(201, result);
    } catch (err) {
      return authPolicyResponse(err, requestId, "issue");
    }
  }
  if (method === "GET" && tokenId === undefined) {
    const filterNs = url.searchParams.get("ns") || undefined;
    try {
      const result = await env.AUTH.list({
        ns: filterNs,
        requestId,
      });
      return jsonResponse(200, result);
    } catch (err) {
      return authPolicyResponse(err, requestId, "list");
    }
  }
  if (method === "DELETE" && tokenId !== undefined) {
    try {
      const result = await env.AUTH.revoke({ tokenId, requestId });
      log("info", "auth_token_revoked", {
        request_id: requestId,
        token_id: tokenId,
        revoked: result.revoked,
      });
      return jsonResponse(200, result);
    } catch (err) {
      return authPolicyResponse(err, requestId, "revoke");
    }
  }
  return jsonError(405, "method_not_allowed", "Method not allowed for /auth/tokens");
}
