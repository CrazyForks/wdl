/** @param {string} ch */
function isSqlWordStart(ch) {
  return /[A-Za-z_]/.test(ch);
}

/** @param {string} ch */
function isSqlWordPart(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function createStatementTracker() {
  return {
    triggerPrefix: /** @type {string[]} */ ([]),
    triggerPrefixRejected: false,
    isTrigger: false,
    triggerBodyStarted: false,
    triggerNestedDepth: 0,
    triggerEndMayClose: false,
    triggerEndSeen: false,
  };
}

/**
 * @param {ReturnType<typeof createStatementTracker>} tracker
 * @param {string} word
 */
function observeWord(tracker, word) {
  const lower = word.toLowerCase();

  if (!tracker.isTrigger && !tracker.triggerPrefixRejected) {
    const prefix = tracker.triggerPrefix;
    if (prefix.length === 0) {
      if (lower === "create") prefix.push(lower);
      else tracker.triggerPrefixRejected = true;
    } else if (prefix.length === 1) {
      if (lower === "trigger") tracker.isTrigger = true;
      else if (lower === "temp" || lower === "temporary") prefix.push(lower);
      else tracker.triggerPrefixRejected = true;
    } else if (prefix.length === 2) {
      if (lower === "trigger") tracker.isTrigger = true;
      else tracker.triggerPrefixRejected = true;
    }
  }

  if (!tracker.isTrigger) return;
  if (!tracker.triggerBodyStarted) {
    if (lower === "begin") {
      tracker.triggerBodyStarted = true;
      tracker.triggerEndMayClose = true;
    }
    return;
  }

  if (lower === "case" || lower === "begin") {
    tracker.triggerNestedDepth += 1;
    tracker.triggerEndMayClose = false;
    tracker.triggerEndSeen = false;
  } else if (lower === "end") {
    if (tracker.triggerNestedDepth > 0) tracker.triggerNestedDepth -= 1;
    else tracker.triggerEndSeen = tracker.triggerEndMayClose;
    tracker.triggerEndMayClose = false;
  } else {
    tracker.triggerEndMayClose = false;
    tracker.triggerEndSeen = false;
  }
}

/**
 * @param {string} sql
 * @returns {{ sql: string, params: unknown[] }[]}
 */
export function splitSqlStatements(sql) {
  /** @type {{ sql: string, params: unknown[] }[]} */
  const statements = [];
  let start = 0;
  let state = "normal";
  let tracker = createStatementTracker();

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === "line-comment") {
      if (ch === "\n" || ch === "\r") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        state = "normal";
        i += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (ch === "'" && next === "'") i += 1;
      else if (ch === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      if (ch === "\"" && next === "\"") i += 1;
      else if (ch === "\"") state = "normal";
      continue;
    }
    if (state === "backtick") {
      if (ch === "`" && next === "`") i += 1;
      else if (ch === "`") state = "normal";
      continue;
    }
    if (state === "bracket") {
      if (ch === "]") state = "normal";
      continue;
    }

    if (ch === "-" && next === "-") {
      state = "line-comment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block-comment";
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = "single-quote";
      continue;
    }
    if (ch === "\"") {
      state = "double-quote";
      continue;
    }
    if (ch === "`") {
      state = "backtick";
      continue;
    }
    if (ch === "[") {
      state = "bracket";
      continue;
    }
    if (isSqlWordStart(ch)) {
      let end = i + 1;
      while (end < sql.length && isSqlWordPart(sql[end])) end += 1;
      observeWord(tracker, sql.slice(i, end));
      i = end - 1;
      continue;
    }
    if (ch === ";") {
      const statement = sql.slice(start, i).trim();
      if (statement && tracker.isTrigger && tracker.triggerBodyStarted && !tracker.triggerEndSeen) {
        tracker.triggerEndMayClose = true;
        continue;
      }
      if (statement) statements.push({ sql: statement, params: [] });
      start = i + 1;
      tracker = createStatementTracker();
    }
  }

  const trailing = sql.slice(start).trim();
  if (trailing) statements.push({ sql: trailing, params: [] });
  return statements;
}
