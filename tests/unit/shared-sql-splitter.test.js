import { test } from "node:test";
import assert from "node:assert/strict";

import { splitSqlStatements } from "../../shared/sql-splitter.js";

test("SQL splitter: ignores semicolons inside strings, comments, and quoted identifiers", () => {
  assert.deepEqual(
    splitSqlStatements(`
      insert into messages (id, body) values ('semi', 'a;b');
      -- ignored ; in line comment
      insert into messages (id, body) values ("quoted;id", 'c');
      /* ignored ; in block comment */
      select [semi;column] from \`semi;table\`;
    `),
    [
      { sql: "insert into messages (id, body) values ('semi', 'a;b')", params: [] },
      {
        sql: "-- ignored ; in line comment\n      insert into messages (id, body) values (\"quoted;id\", 'c')",
        params: [],
      },
      {
        sql: "/* ignored ; in block comment */\n      select [semi;column] from `semi;table`",
        params: [],
      },
    ]
  );
});

test("SQL splitter: preserves CREATE TRIGGER bodies", () => {
  const statements = splitSqlStatements(`
    create table posts (id text primary key, title text);
    create table post_audit (id text primary key, title text);
    create trigger posts_ai after insert on posts
    begin
      insert into post_audit (id, title) values (new.id, new.title);
      update post_audit set title = title || ';seen' where id = new.id;
    end;
    insert into posts (id, title) values ('p1', 'hello');
  `);

  assert.equal(statements.length, 4);
  assert.match(statements[2].sql, /^create trigger/i);
  assert.match(statements[2].sql, /insert into post_audit/);
  assert.match(statements[2].sql, /update post_audit/);
  assert.match(statements[3].sql, /^insert into posts/);
});

test("SQL splitter: preserves CREATE TRIGGER bodies with trailing END comments", () => {
  const statements = splitSqlStatements(`
    create table posts (id text primary key);
    create trigger posts_ai after insert on posts
    begin
      insert into posts (id) values ('shadow');
    end /* trailing comment */;
    insert into posts (id) values ('p1');
  `);

  assert.equal(statements.length, 3);
  assert.match(statements[1].sql, /^create trigger/i);
  assert.match(statements[2].sql, /^insert into posts \(id\) values \('p1'\)/i);
});

test("SQL splitter: preserves trigger CASE expressions", () => {
  const statements = splitSqlStatements(`
    create table posts (id text primary key, title text);
    create trigger posts_ai after insert on posts
    begin
      update posts
      set title = case when new.title = '' then 'untitled' else new.title end
      where id = new.id;
      insert into posts (id, title) values ('shadow', 'case seen');
    end;
    insert into posts (id, title) values ('p1', 'hello');
  `);

  assert.equal(statements.length, 3);
  assert.match(statements[1].sql, /^create trigger/i);
  assert.match(statements[1].sql, /case when new\.title/);
  assert.match(statements[1].sql, /insert into posts \(id, title\) values \('shadow'/);
  assert.match(statements[2].sql, /^insert into posts/);
});

test("SQL splitter: recognizes triggers after leading comments", () => {
  const statements = splitSqlStatements(`
    /* migration comment */
    -- trigger setup
    create trigger posts_ai after insert on posts
    begin
      insert into posts (id) values ('shadow');
    end;
    select 1;
  `);

  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /create trigger posts_ai/i);
  assert.match(statements[1].sql, /^select 1/i);
});

test("SQL splitter: ignores trigger keywords inside strings and comments", () => {
  const statements = splitSqlStatements(`
    create trigger posts_ai after insert on posts
    begin
      insert into posts (id) values ('literal END; still open');
      -- CASE and END in a comment must not change trigger depth;
      /* BEGIN CASE END */
      insert into posts (id) values ('literal CASE');
    end;
    select 1;
  `);

  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /literal END; still open/);
  assert.match(statements[0].sql, /literal CASE/);
  assert.match(statements[1].sql, /^select 1/i);
});

test("SQL splitter: only closes triggers on END at a substatement boundary", () => {
  const statements = splitSqlStatements(`
    create trigger posts_ai after insert on posts
    begin
      select 1 as end;
      insert into posts (id) values ('shadow');
    end;
    select 1;
  `);

  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /select 1 as end;/i);
  assert.match(statements[0].sql, /insert into posts/);
  assert.match(statements[1].sql, /^select 1/i);
});

test("SQL splitter: handles empty SQL and trailing semicolons", () => {
  assert.deepEqual(splitSqlStatements(" ; \n\t ; "), []);
  assert.deepEqual(splitSqlStatements("select 1;;\nselect 2;"), [
    { sql: "select 1", params: [] },
    { sql: "select 2", params: [] },
  ]);
});
