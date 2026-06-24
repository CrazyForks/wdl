import {
  classifyD1Error,
  d1ErrorPayload,
  d1ErrorResponse,
} from "d1-runtime-protocol";
import {
  createLogLevelBinder,
} from "shared-observability";
import {
  createHttpRequestScope,
} from "shared-request-scope";
import {
  handleDrain,
  handleHealth,
  handleProbe,
  handleRebalance,
  handleRenew,
  handleMetrics,
} from "d1-runtime-ops";
import { D1DatabaseActor } from "d1-runtime-actor";
import { jsonError } from "d1-runtime-http";
import {
  handleQuery,
  handleTestHookQuery,
} from "d1-runtime-router";
import {
  internalAuthFailureResponse,
  verifyInternalAuthHeaders,
} from "shared-internal-auth";
import {
  log,
  metrics,
  SERVICE,
} from "d1-runtime-state";

export { D1DatabaseActor };

const bindLogLevel = createLogLevelBinder();

/** @param {string} method @param {string} pathname */
function routeName(method, pathname) {
  if (method === "GET" && pathname === "/healthz") return "healthz";
  if (method === "GET" && pathname === "/_metrics") return "metrics";
  if (method === "GET" && pathname === "/internal/d1/probe") return "d1_probe";
  if (method === "POST" && pathname === "/internal/d1/drain") return "d1_drain";
  if (method === "POST" && pathname === "/internal/d1/renew") return "d1_renew";
  if (method === "POST" && pathname === "/internal/d1/rebalance") return "d1_rebalance";
  if (method === "POST" && pathname === "/internal/d1/test-hook/query") return "d1_test_hook_query";
  if (method === "POST" && pathname === "/internal/d1/query") return "d1_query";
  return "not_found";
}

/** @param {string} method @param {string} pathname */
function isD1QueryRoute(method, pathname) {
  return method === "POST" && (
    pathname === "/internal/d1/query" ||
    pathname === "/internal/d1/test-hook/query"
  );
}

/** @param {unknown} err */
function d1JsonErrorResponse(err) {
  const classified = classifyD1Error(err);
  return Response.json(d1ErrorPayload(err), { status: classified.status });
}

/**
 * @typedef {Record<string, unknown> & { LOG_LEVEL?: unknown, D1_DATABASES?: DurableObjectNamespace, D1_TEST_HOOKS?: unknown, D1_ACTOR_IDLE_WAIT_TIMEOUT_MS?: unknown, D1_DRAIN_TIMEOUT_MS?: unknown, D1_QUERY_TIMEOUT_MS?: unknown }} D1Env
 */

export default {
  /** @param {Request} request @param {D1Env} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    bindLogLevel(env);
    const scope = createHttpRequestScope({
      request,
      service: SERVICE,
      metrics,
      log,
      route: routeName(request.method, url.pathname),
      probeRoutes: ["healthz", "metrics", "d1_probe"],
    });

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return scope.respond(await handleHealth(env));
      }
      if (request.method === "GET" && url.pathname === "/_metrics") {
        return scope.respond(handleMetrics());
      }
      if (!verifyInternalAuthHeaders(request.headers, env)) {
        return scope.respond(internalAuthFailureResponse());
      }
      if (request.method === "GET" && url.pathname === "/internal/d1/probe") {
        return scope.respond(await handleProbe(url, env));
      }
      if (request.method === "POST" && url.pathname === "/internal/d1/drain") {
        return scope.respond(await handleDrain(env));
      }
      if (request.method === "POST" && url.pathname === "/internal/d1/renew") {
        return scope.respond(await handleRenew(env));
      }
      if (request.method === "POST" && url.pathname === "/internal/d1/rebalance") {
        return scope.respond(await handleRebalance(request, env));
      }
      if (request.method === "POST" && url.pathname === "/internal/d1/test-hook/query") {
        return scope.respond(await handleTestHookQuery(request, env, scope.requestId));
      }
      if (request.method === "POST" && url.pathname === "/internal/d1/query") {
        return scope.respond(await handleQuery(request, env, scope.requestId));
      }
      return scope.respond(jsonError(404, "not_found", "Not found"));
    } catch (err) {
      scope.markError(err);
      return scope.respond(
        isD1QueryRoute(request.method, url.pathname)
          ? d1ErrorResponse(err)
          : d1JsonErrorResponse(err)
      );
    } finally {
      scope.complete();
    }
  },
};
