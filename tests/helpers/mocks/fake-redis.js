/** @typedef {Map<string, string>} FakeRedisStrings */
/** @typedef {Map<string, Record<string, string>>} FakeRedisHashes */
/** @typedef {Map<string, Set<string>>} FakeRedisSets */
/** @typedef {Map<string, Map<string, number>>} FakeRedisZSets */

/**
 * @typedef {{
 *   strings: FakeRedisStrings,
 *   hashes: FakeRedisHashes,
 *   sets: FakeRedisSets,
 *   zsets: FakeRedisZSets,
 *   ops: unknown[][],
 *   watched: string[],
 *   watchBatches: string[][],
 *   commands: unknown[][],
 *   expirations: Map<string, number>,
 *   execFailures: number,
 *   nowMs: number,
 * }} FakeRedisState
 */

export class FakeRedisWatchError extends Error {
  constructor(message = "watched key changed") {
    super(message);
    this.name = "WatchError";
  }
}

/** @returns {FakeRedisState} */
export function createFakeRedisState() {
  return {
    strings: new Map(),
    hashes: new Map(),
    sets: new Map(),
    zsets: new Map(),
    ops: [],
    watched: [],
    watchBatches: [],
    commands: [],
    expirations: new Map(),
    execFailures: 0,
    nowMs: Date.now(),
  };
}

/** @param {FakeRedisState} state */
export function resetFakeRedisState(state) {
  state.strings.clear();
  state.hashes.clear();
  state.sets.clear();
  state.zsets.clear();
  state.ops.length = 0;
  state.watched.length = 0;
  state.watchBatches.length = 0;
  state.commands.length = 0;
  state.expirations.clear();
  state.execFailures = 0;
  state.nowMs = Date.now();
}

/**
 * @param {FakeRedisState} [state]
 * @param {{ encodeGet?: boolean, nowMs?: () => number, onExecFailure?: (ops: unknown[][], remainingFailures: number) => void }} [options]
 * @returns {ReturnType<typeof createFakeRedisClient> & FakeRedisState & { state: FakeRedisState }}
 */
export function createFakeRedis(state = createFakeRedisState(), options = {}) {
  return {
    state,
    strings: state.strings,
    hashes: state.hashes,
    sets: state.sets,
    zsets: state.zsets,
    expirations: state.expirations,
    get execFailures() { return state.execFailures; },
    set execFailures(value) { state.execFailures = value; },
    ops: state.ops,
    watched: state.watched,
    watchBatches: state.watchBatches,
    commands: state.commands,
    get nowMs() { return state.nowMs; },
    set nowMs(value) { state.nowMs = value; },
    ...createFakeRedisClient(state, options),
  };
}

/**
 * @param {FakeRedisState} state
 * @param {{ encodeGet?: boolean, nowMs?: () => number, onExecFailure?: (ops: unknown[][], remainingFailures: number) => void }} [options]
 */
export function createFakeRedisClient(state, options = {}) {
  const session = createFakeRedisSession(state, options);
  return {
    /** @param {string} key */
    async get(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["get", key]);
      return encodeMaybe(state.strings.get(key) ?? null, options);
    },
    /** @param {string} key */
    async getWithTime(key) {
      return { value: await this.get(key), nowMs: await this.time() };
    },
    async time() {
      return currentFakeRedisTimeMs(state, options);
    },
    /** @param {string} key */
    async incr(key) {
      state.commands.push(["incr", key]);
      const next = Number(state.strings.get(key) || 0) + 1;
      state.strings.set(key, String(next));
      return next;
    },
    /** @param {string} key @param {string} value @param {{ nx?: boolean, ttl?: number, ifeq?: string }} [setOptions] */
    async set(key, value, setOptions = {}) {
      expireIfNeeded(state, key, options);
      state.commands.push(["set", key, value, { ...setOptions }]);
      if (setOptions.nx && keyExists(state, key, options)) return null;
      if (setOptions.ifeq != null && state.strings.get(key) !== setOptions.ifeq) return null;
      state.strings.set(key, value);
      if (typeof setOptions.ttl === "number") {
        state.expirations.set(key, currentFakeRedisTimeMs(state, options) + setOptions.ttl * 1000);
      } else {
        state.expirations.delete(key);
      }
      return "OK";
    },
    /** @param {...string} keys */
    async del(...keys) {
      state.commands.push(["del", ...keys]);
      let removed = 0;
      for (const key of keys) removed += deleteKey(state, key, options);
      return removed;
    },
    /** @param {string} key @param {string} value */
    async delIfEq(key, value) {
      expireIfNeeded(state, key, options);
      state.commands.push(["delIfEq", key, value]);
      if (state.strings.get(key) !== value) return 0;
      return deleteKey(state, key, options);
    },
    /** @param {string} cursor @param {string} match @param {number} [count] */
    async scan(cursor, match, count = 100) {
      const result = scanKeys(state, cursor, match, count, options);
      state.commands.push(["scan", cursor, match, count, result]);
      return result;
    },
    /** @param {string} key @param {string} field */
    async hGet(key, field) {
      expireIfNeeded(state, key, options);
      state.commands.push(["hGet", key, field]);
      return state.hashes.get(key)?.[field] ?? null;
    },
    /** @param {Array<[string, string]>} pairs */
    async hGetMany(pairs) {
      state.commands.push(["hGetMany", pairs.map(([key, field]) => [key, field])]);
      return pairs.map(([key, field]) => {
        expireIfNeeded(state, key, options);
        return state.hashes.get(key)?.[field] ?? null;
      });
    },
    /** @param {string} key */
    async hGetAll(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["hGetAll", key]);
      return { ...(state.hashes.get(key) || {}) };
    },
    /** @param {string[]} keys */
    async hGetAllMany(keys) {
      state.commands.push(["hGetAllMany", [...keys]]);
      return keys.map((key) => {
        expireIfNeeded(state, key, options);
        return { ...(state.hashes.get(key) || {}) };
      });
    },
    /** @param {string} key @param {Record<string, string>} fields */
    async hSet(key, fields) {
      expireIfNeeded(state, key, options);
      state.commands.push(["hSet", key, { ...fields }]);
      setHashFields(state, key, fields);
    },
    /** @param {string} key @param {...string} fields */
    async hDel(key, ...fields) {
      expireIfNeeded(state, key, options);
      state.commands.push(["hDel", key, ...fields]);
      const hash = state.hashes.get(key);
      if (!hash) return 0;
      let removed = 0;
      for (const field of fields) {
        if (Object.hasOwn(hash, field)) {
          delete hash[field];
          removed += 1;
        }
      }
      return removed;
    },
    /** @param {string} key */
    async hKeys(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["hKeys", key]);
      return Object.keys(state.hashes.get(key) || {});
    },
    /** @param {string} key */
    async sMembers(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["sMembers", key]);
      return [...(state.sets.get(key) || new Set())];
    },
    /** @param {string} key @param {string} member */
    async sAdd(key, member) {
      expireIfNeeded(state, key, options);
      state.commands.push(["sAdd", key, member]);
      ensureSet(state, key).add(member);
    },
    /** @param {string} key */
    async exists(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["exists", key]);
      return keyExists(state, key, options) ? 1 : 0;
    },
    /** @param {(session: ReturnType<typeof createFakeRedisSession>) => Promise<unknown>} fn */
    async session(fn) {
      return await fn(session);
    },
  };
}

/**
 * @param {FakeRedisState} state
 * @param {{ nowMs?: () => number, onExecFailure?: (ops: unknown[][], remainingFailures: number) => void }} [options]
 */
export function createFakeRedisSession(state, options = {}) {
  return {
    /** @param {string[]} keys */
    async watch(...keys) {
      state.watched.push(...keys);
      state.watchBatches.push(keys);
    },
    async unwatch() {},
    /** @param {string} key */
    async get(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["get", key]);
      return state.strings.get(key) ?? null;
    },
    /** @param {string[]} keys */
    async getMany(keys) {
      state.commands.push(["getMany", [...keys]]);
      return keys.map((key) => {
        expireIfNeeded(state, key, options);
        return state.strings.get(key) ?? null;
      });
    },
    /** @param {string} key */
    async getWithTime(key) {
      return { value: await this.get(key), nowMs: await this.time() };
    },
    async time() {
      return currentFakeRedisTimeMs(state, options);
    },
    /** @param {string} key @param {string} field */
    async hGet(key, field) {
      expireIfNeeded(state, key, options);
      state.commands.push(["hGet", key, field]);
      return state.hashes.get(key)?.[field] ?? null;
    },
    /** @param {Array<[string, string]>} pairs */
    async hGetMany(pairs) {
      state.commands.push(["hGetMany", pairs.map(([key, field]) => [key, field])]);
      return pairs.map(([key, field]) => {
        expireIfNeeded(state, key, options);
        return state.hashes.get(key)?.[field] ?? null;
      });
    },
    /** @param {string} key */
    async hGetAll(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["hGetAll", key]);
      return { ...(state.hashes.get(key) || {}) };
    },
    /** @param {string[]} keys */
    async hGetAllMany(keys) {
      state.commands.push(["hGetAllMany", [...keys]]);
      return keys.map((key) => {
        expireIfNeeded(state, key, options);
        return { ...(state.hashes.get(key) || {}) };
      });
    },
    /** @param {string} key */
    async exists(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["exists", key]);
      return keyExists(state, key, options) ? 1 : 0;
    },
    /** @param {string} key @param {string[]} members */
    async sMIsMember(key, ...members) {
      expireIfNeeded(state, key, options);
      state.commands.push(["sMIsMember", key, [...members]]);
      const set = state.sets.get(key) || new Set();
      return members.map((member) => set.has(member));
    },
    /** @param {string} key */
    async sMembers(key) {
      expireIfNeeded(state, key, options);
      state.commands.push(["sMembers", key]);
      return [...(state.sets.get(key) || new Set())];
    },
    /** @param {...string} keys */
    async del(...keys) {
      state.commands.push(["del", ...keys]);
      let removed = 0;
      for (const key of keys) removed += deleteKey(state, key, options);
      return removed;
    },
    /** @param {string} key @param {string} value */
    async delIfEq(key, value) {
      expireIfNeeded(state, key, options);
      state.commands.push(["delIfEq", key, value]);
      if (state.strings.get(key) !== value) return 0;
      return deleteKey(state, key, options);
    },
    /** @param {string} cursor @param {string} match @param {number} [count] */
    async scan(cursor, match, count = 100) {
      const result = scanKeys(state, cursor, match, count, options);
      state.commands.push(["scan", cursor, match, count, result]);
      return result;
    },
    /** @param {string} src @param {string} dst @param {{ REPLACE?: boolean }} [opts] */
    async copy(src, dst, opts = {}) {
      expireIfNeeded(state, src, options);
      state.commands.push(["copy", src, dst, { ...opts }]);
      const hash = state.hashes.get(src);
      if (!hash) return 0;
      if (!opts.REPLACE && keyExists(state, dst, options)) return 0;
      state.hashes.set(dst, { ...hash });
      return 1;
    },
    multi() {
      return createFakeRedisMulti(state, options);
    },
  };
}

/**
 * @param {FakeRedisState} state
 * @param {{ nowMs?: () => number, onExecFailure?: (ops: unknown[][], remainingFailures: number) => void }} [options]
 */
export function createFakeRedisMulti(state, options = {}) {
  /** @type {unknown[][]} */
  const ops = [];
  const chain = {
    /** @param {string} key @param {Record<string, string> | string} fieldsOrField @param {string} [maybeValue] */
    hSet(key, fieldsOrField, maybeValue) {
      const fields = typeof fieldsOrField === "object"
        ? fieldsOrField
        : { [fieldsOrField]: maybeValue };
      ops.push(["hSet", key, { ...fields }]);
      return chain;
    },
    /** @param {string} key @param {string[]} fields */
    hDel(key, ...fields) {
      ops.push(["hDel", key, ...fields]);
      return chain;
    },
    /** @param {string} key @param {string} value @param {Record<string, unknown>} [options] */
    set(key, value, options = undefined) {
      ops.push(["set", key, value, options]);
      return chain;
    },
    /** @param {string[]} keys */
    del(...keys) {
      ops.push(["del", ...keys]);
      return chain;
    },
    /** @param {string} key @param {(string | string[])[]} values */
    sAdd(key, ...values) {
      for (const value of values.flat()) ops.push(["sAdd", key, value]);
      return chain;
    },
    /** @param {string} key @param {(string | string[])[]} values */
    sRem(key, ...values) {
      for (const value of values.flat()) ops.push(["sRem", key, value]);
      return chain;
    },
    /** @param {string} key @param {number} score @param {string} member */
    zAdd(key, score, member) {
      ops.push(["zAdd", key, score, member]);
      return chain;
    },
    /** @param {string} key @param {string} member */
    zRem(key, member) {
      ops.push(["zRem", key, member]);
      return chain;
    },
    /** @param {string} key @param {string} value */
    publish(key, value) {
      ops.push(["publish", key, value]);
      return chain;
    },
    /** @param {string} key @param {number} ts */
    expireAt(key, ts) {
      ops.push(["expireAt", key, ts]);
      return chain;
    },
    /** @param {string} src @param {string} dst */
    copy(src, dst) {
      ops.push(["copy", src, dst]);
      return chain;
    },
    async exec() {
      if (state.execFailures > 0) {
        state.execFailures -= 1;
        options.onExecFailure?.(ops, state.execFailures);
        throw new FakeRedisWatchError();
      }
      state.ops.push(...ops);
      state.commands.push(...ops);
      for (const op of ops) applyFakeRedisOp(state, op, options);
      return ops.map(() => 1);
    },
  };
  return chain;
}

/**
 * @param {FakeRedisState} state
 * @param {unknown[]} op
 * @param {{ nowMs?: () => number }} [options]
 */
export function applyFakeRedisOp(state, op, options = {}) {
  const kind = /** @type {string} */ (op[0]);
  if (kind === "del") {
    for (const key of /** @type {string[]} */ (op.slice(1))) {
      deleteKey(state, key, options);
    }
    return;
  }

  const key = /** @type {string} */ (op[1]);
  if (kind === "set") {
    const setOptions = /** @type {{ nx?: boolean, ttl?: number, ifeq?: string } | undefined} */ (op[3]) ?? {};
    expireIfNeeded(state, key, options);
    if (setOptions.nx && keyExists(state, key, options)) return;
    if (setOptions.ifeq != null && state.strings.get(key) !== setOptions.ifeq) return;
    state.strings.set(key, /** @type {string} */ (op[2]));
    if (typeof setOptions.ttl === "number") {
      state.expirations.set(key, currentFakeRedisTimeMs(state, options) + setOptions.ttl * 1000);
    } else {
      state.expirations.delete(key);
    }
    return;
  }
  if (kind === "hSet") {
    setHashFields(state, key, /** @type {Record<string, string>} */ (op[2]));
    return;
  }
  if (kind === "hDel") {
    const hash = state.hashes.get(key);
    if (!hash) return;
    for (const field of /** @type {string[]} */ (op.slice(2))) delete hash[field];
    return;
  }
  if (kind === "copy") {
    const hash = state.hashes.get(key);
    if (hash) state.hashes.set(/** @type {string} */ (op[2]), { ...hash });
    return;
  }
  if (kind === "sAdd") {
    ensureSet(state, key).add(/** @type {string} */ (op[2]));
    return;
  }
  if (kind === "sRem") {
    state.sets.get(key)?.delete(/** @type {string} */ (op[2]));
    return;
  }
  if (kind === "zAdd") {
    const zset = state.zsets.get(key) || new Map();
    zset.set(/** @type {string} */ (op[3]), /** @type {number} */ (op[2]));
    state.zsets.set(key, zset);
    return;
  }
  if (kind === "zRem") {
    state.zsets.get(key)?.delete(/** @type {string} */ (op[2]));
  }
}

/** @param {FakeRedisState} state @param {string} key */
function ensureSet(state, key) {
  if (!state.sets.has(key)) state.sets.set(key, new Set());
  return /** @type {Set<string>} */ (state.sets.get(key));
}

/** @param {FakeRedisState} state @param {string} key @param {Record<string, string>} fields */
function setHashFields(state, key, fields) {
  state.hashes.set(key, { ...(state.hashes.get(key) || {}), ...fields });
}

/** @param {FakeRedisState} state @param {string} key */
function keyExists(state, key, options = {}) {
  expireIfNeeded(state, key, options);
  return state.strings.has(key) || state.hashes.has(key) || state.sets.has(key) || state.zsets.has(key);
}

/**
 * @param {FakeRedisState} state
 * @param {string} key
 * @param {{ nowMs?: () => number }} [options]
 */
function deleteKey(state, key, options = {}) {
  expireIfNeeded(state, key, options);
  const existed = keyExists(state, key, options);
  state.strings.delete(key);
  state.hashes.delete(key);
  state.sets.delete(key);
  state.zsets.delete(key);
  state.expirations.delete(key);
  return existed ? 1 : 0;
}

/**
 * @param {FakeRedisState} state
 * @param {string} key
 * @param {{ nowMs?: () => number }} [options]
 */
function expireIfNeeded(state, key, options = {}) {
  const expiresAt = state.expirations.get(key);
  if (expiresAt == null || currentFakeRedisTimeMs(state, options) < expiresAt) return;
  state.expirations.delete(key);
  state.strings.delete(key);
  state.hashes.delete(key);
  state.sets.delete(key);
  state.zsets.delete(key);
}

/**
 * @param {FakeRedisState} state
 * @param {string} cursor
 * @param {string} match
 * @param {number} count
 * @param {{ nowMs?: () => number }} [options]
 * @returns {[string, string[]]}
 */
function scanKeys(state, cursor, match, count, options = {}) {
  const pattern = globToRegExp(match);
  const keys = [...new Set([
    ...state.strings.keys(),
    ...state.hashes.keys(),
    ...state.sets.keys(),
    ...state.zsets.keys(),
  ])]
    .filter((key) => {
      expireIfNeeded(state, key, options);
      return keyExists(state, key, options) && pattern.test(key);
    })
    .toSorted();
  const start = Math.max(0, Number(cursor) || 0);
  const safeCount = Math.max(1, count | 0);
  const page = keys.slice(start, start + safeCount);
  const next = start + safeCount >= keys.length ? "0" : String(start + safeCount);
  return [next, page];
}

/** @param {string} glob */
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** @param {string | null} value @param {{ encodeGet?: boolean }} options */
function encodeMaybe(value, options) {
  if (!options.encodeGet || value == null) return value;
  return new TextEncoder().encode(value);
}

/** @param {FakeRedisState} state @param {{ nowMs?: () => number }} options */
function currentFakeRedisTimeMs(state, options) {
  return options.nowMs?.() ?? state.nowMs;
}
