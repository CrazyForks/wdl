import { installMockGlobal, withMockedGlobal } from "./mock-global.js";

/**
 * @typedef {{ url: string, init: RequestInit }} RecordedFetchCall
 */

/**
 * Replaces global fetch and returns an idempotent restore function.
 *
 * Use this for tests that need to install a mock before running multiple
 * operations. Prefer withMockedFetch when the mock has one lexical async scope.
 *
 * @param {typeof globalThis.fetch} mockImpl
 * @returns {() => void}
 */
export function installMockFetch(mockImpl) {
  return installMockGlobal("fetch", mockImpl);
}

/**
 * Temporarily replaces global fetch for a single async test scope.
 *
 * Use this instead of hand-written save/restore blocks so failed assertions do
 * not leak a mocked fetch into later tests.
 *
 * @template {() => unknown | Promise<unknown>} TCallback
 * @param {typeof globalThis.fetch} mockImpl
 * @param {TCallback} callback
 * @returns {Promise<Awaited<ReturnType<TCallback>>>}
 */
export async function withMockedFetch(mockImpl, callback) {
  return await withMockedGlobal("fetch", mockImpl, callback);
}

/**
 * Builds a fetch mock that records every call before returning a response.
 *
 * @template TCall
 * @param {TCall[]} calls
 * @param {{
 *   response?: Response | ((url: RequestInfo | URL, init: RequestInit, call: TCall) => Response | Promise<Response>),
 *   capture?: (call: RecordedFetchCall, url: RequestInfo | URL, init: RequestInit) => TCall,
 * }} [options]
 * @returns {typeof globalThis.fetch}
 */
export function makeRecordingFetch(calls, options = {}) {
  const response = options.response || new Response(null, { status: 204 });
  return async (url, init = {}) => {
    const baseCall = { url: String(url), init };
    const call = options.capture ? options.capture(baseCall, url, init) : /** @type {TCall} */ (baseCall);
    calls.push(call);
    if (typeof response === "function") {
      return await response(url, init, call);
    }
    return response.clone();
  };
}

/**
 * Installs a recording fetch mock for one async scope.
 *
 * @template TCall
 * @template {() => unknown | Promise<unknown>} TCallback
 * @param {TCall[]} calls
 * @param {TCallback} callback
 * @param {Parameters<typeof makeRecordingFetch<TCall>>[1]} [options]
 * @returns {Promise<Awaited<ReturnType<TCallback>>>}
 */
export async function withRecordingFetch(calls, callback, options = {}) {
  return await withMockedFetch(makeRecordingFetch(calls, options), callback);
}
