import {
  WORKER_NAME_RE,
  WORKFLOW_NAME_RE,
  isValidWorkerName,
  isValidWorkflowName,
  workflowDefsKey,
} from "control-lib";
import {
  codedErrorResponse,
  controlInternalJsonHeaders,
  errMessage,
  getControlWorkflows,
  jsonError,
  jsonResponse,
  requireControlLog,
  requireControlRedis,
} from "control-shared";
import { bundleKey, routesKey } from "shared-version";

const LIFECYCLE_ACTIONS = new Set(["pause", "resume", "restart", "terminate"]);

/**
 * @typedef {import("shared-redis").RedisClient} RedisClient
 * @typedef {{ fetch: typeof fetch }} WorkflowBackend
 * @typedef {{ method: string, url: URL, ns: string, subPath: string[], requestId: string }} WorkflowsHandlerArgs
 * @typedef {{ redis: RedisClient }} RedisDeps
 * @typedef {{ redis: RedisClient, workflows: WorkflowBackend | null }} WorkflowDeps
 * @typedef {{ name: string, binding: string, className: string, workflowKey: string }} ActiveWorkflowMeta
 * @typedef {{ name: string, binding: string | null, className: string, workflowKey: string, retired?: boolean }} WorkflowEntry
 * @typedef {WorkflowEntry & { namespace: string, worker: string, activeVersion: string }} ListedWorkflowEntry
 * @typedef {{ workflowKey: string, className: string }} RetiredWorkflowDef
 * @typedef {Record<string, RetiredWorkflowDef>} RetiredWorkflowDefs
 * @typedef {{
 *   ns: string,
 *   worker: string,
 *   frozenVersion: string,
 *   workflowName: string,
 *   workflowKey: string,
 *   className: string,
 *   instanceId?: string,
 *   options?: Record<string, unknown>,
 *   requestId?: string,
 * }} WorkflowRequest
 * @typedef {{ workflow: WorkflowEntry, request: WorkflowRequest }} ResolvedWorkflow
 * @typedef {{ error: string, message?: unknown, [key: string]: unknown }} UpstreamErrorBody
 */

/** @param {WorkflowsHandlerArgs} args */
export async function handle({ method, url, ns, subPath, requestId }) {
  try {
    return await handleInner({ method, url, ns, subPath, requestId });
  } catch (err) {
    if (err instanceof WorkflowControlError) {
      return codedErrorResponse(err);
    }
    throw err;
  }
}

/** @param {WorkflowsHandlerArgs} args */
async function handleInner({ method, url, ns, subPath, requestId }) {
  const redis = requireControlRedis();
  const workflows = getControlWorkflows();
  const log = requireControlLog();
  const deps = { redis, workflows };
  if (method === "GET" && subPath.length === 0) {
    const body = await listWorkflowDefinitions(deps, ns);
    log("info", "workflows_listed", {
      request_id: requestId,
      namespace: ns,
      count: body.workflows.length,
    });
    return jsonResponse(200, body);
  }

  if (subPath.length >= 3 && subPath[2] === "instances") {
    const [worker, workflowName] = subPath;
    const workflow = await resolveWorkflow(deps, ns, worker, workflowName);

    if (method === "GET" && subPath.length === 3) {
      const body = await callWorkflowsRust(deps, "instances", {
        ...workflow.request,
        options: listOptions(url),
        requestId,
      });
      log("info", "workflow_instances_listed", {
        request_id: requestId,
        namespace: ns,
        worker,
        workflow: workflowName,
        count: Array.isArray(body.instances) ? body.instances.length : 0,
      });
      return jsonResponse(200, body);
    }

    if (subPath.length >= 4) {
      const instanceId = decodePathSegment(subPath[3], "workflow instance id");
      if (method === "GET" && subPath.length === 4) {
        const body = await callWorkflowsRust(deps, "status", {
          ...workflow.request,
          instanceId,
          options: statusOptions(url),
          requestId,
        });
        log("info", "workflow_instance_status_read", {
          request_id: requestId,
          namespace: ns,
          worker,
          workflow: workflowName,
          instance_id: instanceId,
          status: body.status || null,
        });
        return jsonResponse(200, body);
      }

      if (method === "POST" && subPath.length === 5 && LIFECYCLE_ACTIONS.has(subPath[4])) {
        const action = subPath[4];
        if (workflow.workflow?.retired && action === "restart") {
          throw new WorkflowControlError(409, "workflow_not_exported", `Workflow ${ns}/${worker}/${workflowName} is not exported by the active worker version`);
        }
        const body = await callWorkflowsRust(deps, action, {
          ...workflow.request,
          instanceId,
          requestId,
        });
        log("info", "workflow_instance_lifecycle", {
          request_id: requestId,
          namespace: ns,
          worker,
          workflow: workflowName,
          instance_id: instanceId,
          action,
          status: body.status || null,
        });
        return jsonResponse(200, body);
      }
    }
  }

  return jsonError(404, "not_found", "Not found");
}

/**
 * @param {RedisDeps} deps
 * @param {string} ns
 */
async function listWorkflowDefinitions({ redis }, ns) {
  const routes = await redis.hGetAll(routesKey(ns));
  /** @type {Array<[string, string]>} */
  const routeEntries = [];
  for (const [worker, activeVersion] of Object.entries(routes)) {
    if (typeof activeVersion === "string" && activeVersion) routeEntries.push([worker, activeVersion]);
  }
  if (routeEntries.length === 0) return { namespace: ns, workflows: [] };
  const [metaRaws, defsRaws] = await readWorkflowListRaws({ redis }, ns, routeEntries);
  /** @type {ListedWorkflowEntry[]} */
  const workflows = [];
  for (let i = 0; i < routeEntries.length; i += 1) {
    const [worker, activeVersion] = routeEntries[i];
    const meta = parseBundleMetaRaw(ns, worker, activeVersion, metaRaws[i]);
    const activeByName = new Map();
    for (const workflow of workflowsFromMeta(meta)) {
      activeByName.set(workflow.name, workflow);
      workflows.push({
        namespace: ns,
        worker,
        activeVersion,
        name: workflow.name,
        binding: workflow.binding,
        className: workflow.className,
        workflowKey: workflow.workflowKey,
      });
    }
    const defs = parseWorkflowDefs(defsRaws[i]);
    for (const [name, def] of Object.entries(defs)) {
      if (activeByName.has(name)) continue;
      workflows.push({
        namespace: ns,
        worker,
        activeVersion,
        name,
        binding: null,
        className: def.className,
        workflowKey: def.workflowKey,
        retired: true,
      });
    }
  }
  const sortedWorkflows = workflows.toSorted((a, b) =>
    a.worker.localeCompare(b.worker) ||
    a.name.localeCompare(b.name)
  );
  return { namespace: ns, workflows: sortedWorkflows };
}

/**
 * @param {RedisDeps} deps
 * @param {string} ns
 * @param {string} worker
 * @param {string} workflowName
 * @returns {Promise<ResolvedWorkflow>}
 */
async function resolveWorkflow({ redis }, ns, worker, workflowName) {
  if (!isValidWorkerName(worker)) {
    throw new WorkflowControlError(400, "invalid_worker_name", `Invalid worker name ${JSON.stringify(worker)}. Must match ${WORKER_NAME_RE}.`);
  }
  if (!isValidWorkflowName(workflowName)) {
    throw new WorkflowControlError(400, "invalid_workflow_name", `Invalid workflow name ${JSON.stringify(workflowName)}. Must match ${WORKFLOW_NAME_RE}.`);
  }
  const activeVersion = await redis.hGet(routesKey(ns), worker);
  if (!activeVersion) {
    throw new WorkflowControlError(404, "worker_not_found", `Worker ${ns}/${worker} is not active`);
  }
  const meta = await readBundleMeta({ redis }, ns, worker, activeVersion);
  const workflow = workflowsFromMeta(meta).find((entry) => entry.name === workflowName);
  if (workflow) {
    return {
      workflow,
      request: {
        ns,
        worker,
        frozenVersion: activeVersion,
        workflowName: workflow.name,
        workflowKey: workflow.workflowKey,
        className: workflow.className,
      },
    };
  }

  const defs = await readWorkflowDefs({ redis }, ns, worker);
  const def = Object.hasOwn(defs, workflowName)
    ? defs[workflowName]
    : undefined;
  if (!def) {
    throw new WorkflowControlError(404, "workflow_not_found", `Workflow ${ns}/${worker}/${workflowName} is not exported`);
  }
  const retiredWorkflow = {
    name: workflowName,
    binding: null,
    className: def.className,
    workflowKey: def.workflowKey,
    retired: true,
  };
  return {
    workflow: retiredWorkflow,
    request: {
      ns,
      worker,
      frozenVersion: activeVersion,
      workflowName: retiredWorkflow.name,
      workflowKey: retiredWorkflow.workflowKey,
      className: retiredWorkflow.className,
    },
  };
}

/**
 * @param {RedisDeps} deps
 * @param {string} ns
 * @param {string} worker
 * @returns {Promise<RetiredWorkflowDefs>}
 */
async function readWorkflowDefs({ redis }, ns, worker) {
  return parseWorkflowDefs(await redis.hGetAll(workflowDefsKey(ns, worker)));
}

/**
 * @param {Record<string, string | null | undefined>} raw
 * @returns {RetiredWorkflowDefs}
 */
function parseWorkflowDefs(raw) {
  /** @type {RetiredWorkflowDefs} */
  const defs = Object.create(null);
  for (const [name, value] of Object.entries(raw || {})) {
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value);
      if (
        parsed &&
        typeof parsed.workflowKey === "string" &&
        typeof parsed.className === "string"
      ) {
        defs[name] = {
          workflowKey: parsed.workflowKey,
          className: parsed.className,
        };
      }
    } catch {
      // Corrupt retired definitions are ignored here; execution paths still
      // fail closed inside workflows when they validate a concrete def.
    }
  }
  return defs;
}

/**
 * @param {string} ns
 * @param {string} worker
 * @param {string} version
 * @param {string | Uint8Array | null | undefined} raw
 * @returns {unknown}
 */
function parseBundleMetaRaw(ns, worker, version, raw) {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new WorkflowControlError(500, "corrupt_meta", `Corrupt __meta__ for ${ns}/${worker}/${version}`);
  }
}

/**
 * @param {RedisDeps} deps
 * @param {string} ns
 * @param {Array<[string, string]>} routeEntries
 * @returns {Promise<[Array<string | null | undefined>, Array<Record<string, string | null | undefined>>]>}
 */
async function readWorkflowListRaws({ redis }, ns, routeEntries) {
  try {
    return await Promise.all([
      redis.hGetMany(
        routeEntries.map(([worker, activeVersion]) => [bundleKey(ns, worker, activeVersion), "__meta__"])
      ),
      redis.hGetAllMany(routeEntries.map(([worker]) => workflowDefsKey(ns, worker))),
    ]);
  } catch (err) {
    requireControlLog()("error", "workflow_metadata_unavailable", {
      namespace: ns,
      worker_count: routeEntries.length,
      error_message: errMessage(err),
    });
    throw new WorkflowControlError(500, "workflow_metadata_unavailable", "Workflow metadata is unavailable", {
      namespace: ns,
      worker_count: routeEntries.length,
    });
  }
}

/**
 * @param {RedisDeps} deps
 * @param {string} ns
 * @param {string} worker
 * @param {string} version
 * @returns {Promise<unknown>}
 */
async function readBundleMeta({ redis }, ns, worker, version) {
  let raw;
  try {
    raw = await redis.hGet(bundleKey(ns, worker, version), "__meta__");
  } catch (err) {
    requireControlLog()("error", "workflow_metadata_unavailable", {
      namespace: ns,
      worker,
      version,
      error_message: errMessage(err),
    });
    throw new WorkflowControlError(500, "workflow_metadata_unavailable", "Workflow metadata is unavailable", {
      namespace: ns,
      worker,
      version,
    });
  }
  return parseBundleMetaRaw(ns, worker, version, raw);
}

/**
 * @param {unknown} meta
 * @returns {ActiveWorkflowMeta[]}
 */
function workflowsFromMeta(meta) {
  const record = /** @type {Record<string, unknown> | null} */ (
    meta && typeof meta === "object" ? meta : null
  );
  if (!record || !Array.isArray(record.workflows)) return [];
  return record.workflows.filter(isActiveWorkflowMeta);
}

/**
 * @param {unknown} entry
 * @returns {entry is ActiveWorkflowMeta}
 */
function isActiveWorkflowMeta(entry) {
  const record = /** @type {Record<string, unknown> | null} */ (
    entry && typeof entry === "object" ? entry : null
  );
  return Boolean(
    record &&
    typeof record.name === "string" &&
    typeof record.binding === "string" &&
    typeof record.className === "string" &&
    typeof record.workflowKey === "string",
  );
}

/**
 * @param {WorkflowDeps} deps
 * @param {string} endpoint
 * @param {WorkflowRequest} body
 * @returns {Promise<Record<string, unknown>>}
 */
async function callWorkflowsRust({ workflows }, endpoint, body) {
  if (!workflows || typeof workflows.fetch !== "function") {
    throw new WorkflowControlError(503, "workflow_internal_dispatch_failed", "Workflow backend is unavailable");
  }
  let response;
  let parsed;
  try {
    response = await workflows.fetch(`http://workflows/internal/workflows/${endpoint}`, {
      method: "POST",
      headers: controlInternalJsonHeaders(),
      body: JSON.stringify(body),
    });
    parsed = await response.json().catch(() => null);
  } catch (err) {
    requireControlLog()("error", "workflow_backend_request_failed", {
      request_id: body.requestId || null,
      endpoint,
      error_message: errMessage(err),
    });
    throw new WorkflowControlError(503, "workflow_internal_dispatch_failed", "Workflow backend request failed");
  }
  if (!response.ok) {
    if (isUpstreamErrorBody(parsed)) {
      if (response.status >= 500) {
        requireControlLog()("error", "workflow_backend_error", {
          request_id: body.requestId || null,
          endpoint,
          upstream_status: response.status,
          error: parsed.error,
          error_message: typeof parsed.message === "string" ? parsed.message : null,
        });
      }
      return throwUpstreamError(response.status, parsed);
    }
    throw new WorkflowControlError(
      response.status >= 400 ? response.status : 502,
      "workflow_internal_dispatch_failed",
      "Workflow backend request failed",
      { upstream_status: response.status },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WorkflowControlError(502, "workflow_internal_dispatch_failed", "Workflow backend returned an invalid response");
  }
  return parsed;
}

/**
 * @param {number} status
 * @param {UpstreamErrorBody} body
 * @returns {never}
 */
function throwUpstreamError(status, body) {
  if (status >= 500) {
    throw new WorkflowControlError(
      status,
      body.error,
      "Workflow backend request failed",
      { upstream_status: status },
    );
  }
  throw new WorkflowControlError(
    status,
    body.error,
    typeof body.message === "string" ? body.message : body.error,
    filterDetails(body),
  );
}

/**
 * @param {unknown} body
 * @returns {body is UpstreamErrorBody}
 */
function isUpstreamErrorBody(body) {
  const record = /** @type {Record<string, unknown> | null} */ (
    body && typeof body === "object" ? body : null
  );
  return Boolean(record && typeof record.error === "string");
}

/**
 * @param {UpstreamErrorBody} body
 * @returns {Record<string, unknown>}
 */
function filterDetails(body) {
  /** @type {Record<string, unknown>} */
  const details = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "error" || key === "message") continue;
    details[key] = value;
  }
  return details;
}

/** @param {URL} url */
function listOptions(url) {
  /** @type {Record<string, unknown>} */
  const options = {};
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (limit != null) options.limit = parseIntegerOption(limit, "limit");
  if (cursor != null) options.cursor = cursor;
  return options;
}

/** @param {URL} url */
function statusOptions(url) {
  /** @type {Record<string, unknown>} */
  const options = {};
  if (url.searchParams.has("include_steps") || url.searchParams.has("step_limit")) {
    throw new WorkflowControlError(400, "invalid_request", "workflow status query options use camelCase");
  }
  const includeSteps = url.searchParams.get("includeSteps");
  if (includeSteps != null) options.includeSteps = parseBooleanOption(includeSteps, "includeSteps");
  const stepLimit = url.searchParams.get("stepLimit");
  if (stepLimit != null) options.stepLimit = parseIntegerOption(stepLimit, "stepLimit");
  return options;
}

/**
 * @param {string} raw
 * @param {string} label
 */
function parseIntegerOption(raw, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new WorkflowControlError(400, "invalid_request", `${label} must be an integer`);
  }
  return Number(raw);
}

/**
 * @param {string} raw
 * @param {string} label
 */
function parseBooleanOption(raw, label) {
  // Bare query flags such as ?includeSteps are accepted intentionally;
  // numeric options stay strict because an empty number has no useful meaning.
  if (raw === "" || raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new WorkflowControlError(400, "invalid_request", `${label} must be true or false`);
}

/**
 * @param {string} value
 * @param {string} label
 */
function decodePathSegment(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new WorkflowControlError(400, "invalid_request", `invalid percent-encoding in ${label}`);
  }
}

class WorkflowControlError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
