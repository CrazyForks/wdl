import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  adminFetch,
  adminGet,
  adminPost,
  adminPut,
  assertStatus,
  deployAndPromote,
  serviceInternalGet,
  uniqueNs,
  setupIntegrationSuite,
  responseJson,
} from "./helpers/index.js";
import { d1RuntimeQuery } from "./helpers/d1-runtime.js";

setupIntegrationSuite();

/** @param {string} sql */
function sha256(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

test("D1 lifecycle: create/list/execute/delete database", async () => {
  const ns = uniqueNs("d1life");

  const created = await adminPost(`/ns/${ns}/d1/databases`, {
    databaseName: "main",
  });
  assertStatus(created, 201, "created");
  assert.match(created.json.databaseId, /^d1_[0-9a-f]{32}$/);
  assert.notEqual(created.json.databaseId, "main");
  assert.equal(created.json.databaseName, "main");
  assert.equal(created.json.initialized, true);

  const health = serviceInternalGet("d1-runtime", 8787, "/healthz");
  assertStatus(health, 200, "health");
  const healthBody = responseJson(health);
  assert.ok(healthBody.ownerDbs.owned >= 1, JSON.stringify(healthBody));
  assert.equal(healthBody.ownerDbs.renewed, undefined);
  assert.equal(healthBody.ownerDbs.lost, undefined);

  const migrationTable = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select name from sqlite_master where type = 'table' and name = '_wdl_d1_migrations'",
  });
  assertStatus(migrationTable, 200, "migrationTable");
  assert.deepEqual(migrationTable.json.result.results, [{ name: "_wdl_d1_migrations" }]);

  const listed = await adminGet(`/ns/${ns}/d1/databases`);
  assertStatus(listed, 200, "listed");
  assert.deepEqual(listed.json.databases.map((/** @type {any} */ db) => db.databaseId), [created.json.databaseId]);
  assert.deepEqual(listed.json.databases.map((/** @type {any} */ db) => db.databaseName), ["main"]);

  const init = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "exec",
    sql: `
      create table messages (id text primary key, body text);
      insert into messages (id, body) values ('m1', 'hello;world');
    `,
  });
  assertStatus(init, 200, "init");
  assert.equal(init.json.result.count, 2);

  const selected = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select * from messages where id = ?",
    params: ["m1"],
  });
  assertStatus(selected, 200, "selected");
  assert.deepEqual(selected.json.result.results, [{ id: "m1", body: "hello;world" }]);

  const badSql = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select * from missing_table",
  });
  assertStatus(badSql, 400, "badSql");
  assert.equal(badSql.json.error, "d1_execute_failed");
  assert.equal(badSql.json.upstreamCode, "sql-error");
  assert.equal(badSql.json.upstreamCategory, "sql");
  assert.equal(badSql.json.upstreamRetryable, false);
  assert.match(badSql.json.message, /SQL error:/);

  const badMode = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: 0,
    sql: "select 1",
  });
  assertStatus(badMode, 400, "badMode");
  assert.equal(badMode.json.error, "invalid_request");
  assert.equal(badMode.json.message, "mode must be one of all, raw, run, exec");

  const metrics = serviceInternalGet("d1-runtime", 8787, "/_metrics");
  assertStatus(metrics, 200, "metrics");
  assert.match(metrics.body, /wdl_d1_queries_total\{mode="all",outcome="error",service="d1-runtime"\}/);
  assert.match(metrics.body, /wdl_d1_query_errors_total\{code="sql-error",service="d1-runtime"\}/);
  assert.match(metrics.body, /wdl_d1_open_db_count\{service="d1-runtime"\}/);
  assert.match(metrics.body, /wdl_d1_storage_size_bytes\{service="d1-runtime"\}/);
  assert.doesNotMatch(metrics.body, new RegExp(RegExp.escape(ns)));

  const deleted = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.text());
});

test("D1 lifecycle: recreate with the same name gets fresh physical storage", async () => {
  const ns = uniqueNs("d1recreate");

  const first = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(first, 201, "first");

  const init = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "exec",
    sql: "create table messages (id text primary key, body text); insert into messages values ('m1', 'old');",
  });
  assertStatus(init, 200, "init");

  const deleted = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.text());

  const second = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(second, 201, "second");
  assert.notEqual(second.json.databaseId, first.json.databaseId);

  const tables = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select name from sqlite_master where type = 'table' and name = 'messages'",
  });
  assertStatus(tables, 200, "tables");
  assert.deepEqual(tables.json.result.results, []);
});

test("D1 lifecycle: create requires a database name", async () => {
  const ns = uniqueNs("d1name");

  const missing = await adminPost(`/ns/${ns}/d1/databases`, {});
  assertStatus(missing, 400, "missing");
  assert.equal(missing.json.error, "invalid_request");
  assert.equal(missing.json.message, "databaseName is required");

  const oldShape = await adminPost(`/ns/${ns}/d1/databases`, { databaseId: "main" });
  assertStatus(oldShape, 400, "oldShape");
  assert.equal(oldShape.json.error, "invalid_request");
  assert.equal(oldShape.json.message, "databaseName is required");
});

test("D1 lifecycle: concurrent create for one name yields one database", async () => {
  const ns = uniqueNs("d1race");

  const results = await Promise.all([
    adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" }),
    adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" }),
  ]);
  const statuses = results.map((r) => r.status).toSorted((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409], JSON.stringify(results.map((r) => r.json)));

  const listed = await adminGet(`/ns/${ns}/d1/databases`);
  assertStatus(listed, 200, "listed");
  assert.equal(listed.json.databases.length, 1);
  assert.equal(listed.json.databases[0].databaseName, "main");
});

test("D1 lifecycle: deploy rejects bindings to missing databases and delete blocks active references", async () => {
  const ns = uniqueNs("d1bind");

  const missing = await adminPost(`/ns/${ns}/worker/app/deploy`, {
    code: "export default { fetch() { return new Response('ok'); } };",
    bindings: { DB: { type: "d1", databaseId: "main" } },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, "d1_database_not_found");

  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const version = await deployAndPromote(ns, "app", {
    code: "export default { fetch() { return new Response('ok'); } };",
    bindings: { DB: { type: "d1", databaseId: "main" } },
  });

  const blocked = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  const body = await responseJson(blocked);
  assertStatus(blocked, 409, "active D1 delete", body);
  assert.equal(body.error, "d1_database_in_use");
  assert.equal(body.databaseId, created.json.databaseId);
  assert.equal(body.databaseName, "main");
  assert.deepEqual(body.blockers, [{ worker: "app", version, binding: "DB" }]);
});

test("D1 lifecycle: delete blocks retained version references", async () => {
  const ns = uniqueNs("d1prom");

  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const deployed = await adminPost(`/ns/${ns}/worker/app/deploy`, {
    code: "export default { fetch() { return new Response('ok'); } };",
    bindings: { DB: { type: "d1", databaseId: "main" } },
  });
  assertStatus(deployed, 201, "deployed");

  const blocked = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  const blockedBody = await responseJson(blocked);
  assertStatus(blocked, 409, "retained D1 version delete", blockedBody);
  assert.equal(blockedBody.error, "d1_database_in_use");
  assert.deepEqual(blockedBody.blockers, [{ worker: "app", version: deployed.json.version, binding: "DB" }]);

  const deletedVersion = await adminFetch(`/ns/${ns}/worker/app/versions/${deployed.json.version}`, {
    method: "DELETE",
  });
  assert.equal(deletedVersion.status, 200, await deletedVersion.text());

  const deleted = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.text());
});

test("D1 lifecycle: worker delete removes D1 database referrers", async () => {
  const ns = uniqueNs("d1wdel");

  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const version = await deployAndPromote(ns, "app", {
    code: "export default { fetch() { return new Response('ok'); } };",
    bindings: { DB: { type: "d1", databaseId: "main" } },
  });

  const blocked = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  const blockedBody = await responseJson(blocked);
  assertStatus(blocked, 409, "D1 worker referrer delete", blockedBody);
  assert.deepEqual(blockedBody.blockers, [{ worker: "app", version, binding: "DB" }]);

  const deletedWorker = await adminFetch(`/ns/${ns}/worker/app/delete`, { method: "POST" });
  assert.equal(deletedWorker.status, 200, await deletedWorker.text());

  const deletedDatabase = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  assert.equal(deletedDatabase.status, 200, await deletedDatabase.text());
});

test("D1 lifecycle: secret bump preserves D1 delete blockers for copied versions", async () => {
  const ns = uniqueNs("d1bump");

  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const deployed = await adminPost(`/ns/${ns}/worker/app/deploy`, {
    code: "export default { fetch(_request, env) { return new Response(env.MODE || 'ok'); } };",
    bindings: { DB: { type: "d1", databaseId: "main" } },
  });
  assertStatus(deployed, 201, "deployed");
  const promoted = await adminPost(`/ns/${ns}/worker/app/promote`, { version: deployed.json.version });
  assertStatus(promoted, 200, "promoted");

  const bumped = await adminPut(`/ns/${ns}/worker/app/secrets/MODE`, { value: "bumped" });
  assertStatus(bumped, 200, "bumped");
  assert.equal(bumped.json.version, "v2");

  const deletedV1 = await adminFetch(`/ns/${ns}/worker/app/versions/${deployed.json.version}`, {
    method: "DELETE",
  });
  assert.equal(deletedV1.status, 200, await deletedV1.text());

  const blocked = await adminFetch(`/ns/${ns}/d1/databases/main`, { method: "DELETE" });
  const blockedBody = await responseJson(blocked);
  assertStatus(blocked, 409, "D1 copied version delete", blockedBody);
  assert.equal(blockedBody.error, "d1_database_in_use");
  assert.deepEqual(blockedBody.blockers, [{ worker: "app", version: "v2", binding: "DB" }]);
});

test("D1 backend: batch errors include statement index and rollback", async () => {
  const ns = uniqueNs("d1batch");
  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const failed = d1RuntimeQuery("d1-runtime", {
    namespace: ns,
    databaseId: created.json.databaseId,
    mode: "batch",
    statements: [
      { sql: "create table rolled_back (id text)", params: [] },
      { sql: "insert into missing_table values ('x')", params: [] },
      { sql: "insert into rolled_back values ('x')", params: [] },
    ],
  });
  assertStatus(failed, 400, "failed");
  const failedBody = failed.body;
  assert.equal(failedBody.error, "batch-statement-error");
  assert.equal(failedBody.category, "sql");
  assert.equal(failedBody.retryable, false);
  assert.equal(failedBody.statementIndex, 1);
  assert.equal(failedBody.causeCode, "sql-error");

  const tables = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select name from sqlite_master where type = 'table' and name = 'rolled_back'",
  });
  assertStatus(tables, 200, "tables");
  assert.deepEqual(tables.json.result.results, []);
});

test("D1 backend: exec multi-statement failure rolls back earlier statements", async () => {
  const ns = uniqueNs("d1execrollback");
  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const init = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "run",
    sql: "create table exec_rollback (id text primary key)",
  });
  assertStatus(init, 200, "init");

  const failed = d1RuntimeQuery("d1-runtime", {
    namespace: ns,
    databaseId: created.json.databaseId,
    mode: "exec",
    statements: [
      { sql: "insert into exec_rollback (id) values ('kept-out')", params: [] },
      { sql: "insert into missing_exec_rollback values ('boom')", params: [] },
    ],
  });
  assertStatus(failed, 400, "failed");
  assert.equal(failed.body.error, "sql-error");

  const rows = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select id from exec_rollback order by id",
  });
  assertStatus(rows, 200, "rows");
  assert.deepEqual(rows.json.result.results, []);
});

test("D1 backend: prepared-style multi SQL returns the last statement result", async () => {
  const ns = uniqueNs("d1multi");
  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const response = d1RuntimeQuery("d1-runtime", {
    namespace: ns,
    databaseId: created.json.databaseId,
    mode: "all",
    statements: [
      {
        sql: `
          create table multi_stmt (id text primary key, value text);
          insert into multi_stmt (id, value) values ('m1', 'ok');
          select * from multi_stmt where value = ?;
        `,
        params: ["ok"],
      },
    ],
  });
  assertStatus(response, 200, "response");
  const body = response.body;
  assert.deepEqual(body.results, [{ id: "m1", value: "ok" }]);
});

test("D1 migrations: status/apply/list and checksum mismatch", async () => {
  const ns = uniqueNs("d1mig");
  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const migration = {
    id: "0001_init.sql",
    name: "0001_init",
    sql: `
      create table posts (id text primary key, title text);
      insert into posts (id, title) values ('p1', 'hello; migration');
    `,
  };
  const triggerMigration = {
    id: "0002_trigger.sql",
    name: "0002_trigger",
    sql: `
      create table post_audit (id text primary key, title text);
      create trigger posts_ai after insert on posts
      begin
        insert into post_audit (id, title) values (new.id, new.title);
        update post_audit set title = title || ';seen' where id = new.id;
      end;
      insert into posts (id, title) values ('p2', 'triggered');
    `,
  };

  const before = await adminPost(`/ns/${ns}/d1/databases/main/migrations/status`, {
    migrations: [
      { id: migration.id, name: migration.name, checksum: sha256(migration.sql) },
      { id: triggerMigration.id, name: triggerMigration.name, checksum: sha256(triggerMigration.sql) },
    ],
  });
  assertStatus(before, 200, "before");
  assert.equal(before.json.pending, 2);
  assert.equal(before.json.migrations[0].state, "pending");

  const applied = await adminPost(`/ns/${ns}/d1/databases/main/migrations/apply`, {
    migrations: [migration, triggerMigration],
  });
  assertStatus(applied, 200, "applied");
  assert.deepEqual(applied.json.applied.map((/** @type {any} */ m) => m.id), [migration.id, triggerMigration.id]);
  assert.equal(applied.json.skipped.length, 0);

  const selected = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select * from posts order by id",
  });
  assertStatus(selected, 200, "selected");
  assert.deepEqual(selected.json.result.results, [
    { id: "p1", title: "hello; migration" },
    { id: "p2", title: "triggered" },
  ]);

  const audit = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select * from post_audit",
  });
  assertStatus(audit, 200, "audit");
  assert.deepEqual(audit.json.result.results, [{ id: "p2", title: "triggered;seen" }]);

  const listed = await adminGet(`/ns/${ns}/d1/databases/main/migrations`);
  assertStatus(listed, 200, "listed");
  assert.deepEqual(listed.json.migrations.map((/** @type {any} */ m) => m.id), [migration.id, triggerMigration.id]);
  assert.equal(listed.json.migrations[0].checksum, sha256(migration.sql));

  const reapplied = await adminPost(`/ns/${ns}/d1/databases/main/migrations/apply`, {
    migrations: [migration, triggerMigration],
  });
  assertStatus(reapplied, 200, "reapplied");
  assert.deepEqual(reapplied.json.applied, []);
  assert.deepEqual(reapplied.json.skipped.map((/** @type {any} */ m) => m.id), [migration.id, triggerMigration.id]);

  const mismatch = await adminPost(`/ns/${ns}/d1/databases/main/migrations/apply`, {
    migrations: [{ ...migration, sql: "select 2;" }],
  });
  assertStatus(mismatch, 409, "mismatch");
  assert.equal(mismatch.json.error, "d1_migration_checksum_mismatch");
});

test("D1 migrations: applies larger trigger-heavy SQL", async () => {
  const ns = uniqueNs("d1miglarge");
  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const inserts = Array.from({ length: 120 }, (_, idx) => {
    const id = String(idx + 1).padStart(3, "0");
    return `insert into bulk_posts (id, title) values ('p${id}', 'title ${id}; with semicolon');`;
  }).join("\n");
  const migration = {
    id: "0001_large_trigger.sql",
    name: "0001_large_trigger",
    sql: `
      create table bulk_posts (id text primary key, title text);
      create table bulk_audit (id text primary key, title text);
      create trigger bulk_posts_ai after insert on bulk_posts
      begin
        insert into bulk_audit (id, title) values (new.id, new.title);
        update bulk_audit set title = title || ';seen' where id = new.id;
      end;
      ${inserts}
    `,
  };

  const applied = await adminPost(`/ns/${ns}/d1/databases/main/migrations/apply`, {
    migrations: [migration],
  });
  assertStatus(applied, 200, "applied");
  assert.equal(applied.json.applied[0].statementCount, 123);

  const counts = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: `
      select
        (select count(*) from bulk_posts) as posts,
        (select count(*) from bulk_audit) as audit
    `,
  });
  assertStatus(counts, 200, "counts");
  assert.deepEqual(counts.json.result.results, [{ posts: 120, audit: 120 }]);
});

test("D1 migrations: failed migration rolls back only the current migration", async () => {
  const ns = uniqueNs("d1migfail");
  const created = await adminPost(`/ns/${ns}/d1/databases`, { databaseName: "main" });
  assertStatus(created, 201, "created");

  const good = {
    id: "0001_good.sql",
    name: "0001_good",
    sql: `
      create table stable_posts (id text primary key, title text);
      insert into stable_posts (id, title) values ('p1', 'kept');
    `,
  };
  const bad = {
    id: "0002_bad.sql",
    name: "0002_bad",
    sql: `
      create table transient_posts (id text primary key);
      insert into missing_table values ('boom');
    `,
  };
  const afterBad = {
    id: "0003_after_bad.sql",
    name: "0003_after_bad",
    sql: "create table should_not_run (id text primary key);",
  };

  const failed = await adminPost(`/ns/${ns}/d1/databases/main/migrations/apply`, {
    migrations: [good, bad, afterBad],
  });
  assertStatus(failed, 400, "failed");
  assert.equal(failed.json.error, "d1_migration_apply_failed");
  assert.equal(failed.json.migrationId, bad.id);
  assert.deepEqual(failed.json.applied.map((/** @type {any} */ m) => m.id), [good.id]);
  assert.equal(failed.json.upstreamCode, "batch-statement-error");
  assert.equal(failed.json.detail.statementIndex, 1);
  assert.equal(failed.json.detail.causeCode, "sql-error");

  const stableRows = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: "select * from stable_posts",
  });
  assertStatus(stableRows, 200, "stableRows");
  assert.deepEqual(stableRows.json.result.results, [{ id: "p1", title: "kept" }]);

  const tables = await adminPost(`/ns/${ns}/d1/databases/main/query`, {
    mode: "all",
    sql: `
      select name from sqlite_master
      where type = 'table' and name in ('transient_posts', 'should_not_run')
      order by name
    `,
  });
  assertStatus(tables, 200, "tables");
  assert.deepEqual(tables.json.result.results, []);

  const listed = await adminGet(`/ns/${ns}/d1/databases/main/migrations`);
  assertStatus(listed, 200, "listed");
  assert.deepEqual(listed.json.migrations.map((/** @type {any} */ m) => m.id), [good.id]);
});
