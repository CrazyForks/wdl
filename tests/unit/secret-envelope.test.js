import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SECRET_ENVELOPE_PREFIX,
  decryptSecretValue,
  encryptSecretValue,
  isSecretEnvelope,
} from "../../shared/secret-envelope.js";

const env = {
  SECRET_ENVELOPE_LOCAL_KEY_B64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  SECRET_ENVELOPE_KID: "local:test:secret-envelope:v1",
};

function deterministicRandomFactory() {
  let next = 0;
  return (/** @type {number} */ length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = next++ & 0xff;
    return out;
  };
}

test("secret envelope encrypts and decrypts with storage-location AAD", async () => {
  const envelope = await encryptSecretValue("sensitive-value", {
    env,
    hashKey: "secrets:demo:api",
    fieldName: "TOKEN",
    random: deterministicRandomFactory(),
  });

  assert.equal(isSecretEnvelope(envelope), true);
  assert.ok(envelope.startsWith(SECRET_ENVELOPE_PREFIX));
  assert.equal(envelope.includes("sensitive-value"), false);
  assert.equal(
    await decryptSecretValue(envelope, {
      env,
      hashKey: "secrets:demo:api",
      fieldName: "TOKEN",
    }),
    "sensitive-value"
  );
});

test("secret envelope preserves empty string secrets", async () => {
  const envelope = await encryptSecretValue("", {
    env,
    hashKey: "secrets:demo:api",
    fieldName: "EMPTY",
    random: deterministicRandomFactory(),
  });

  assert.equal(isSecretEnvelope(envelope), true);
  assert.equal(
    await decryptSecretValue(envelope, {
      env,
      hashKey: "secrets:demo:api",
      fieldName: "EMPTY",
    }),
    ""
  );
});

test("secret envelope rejects copy to another hash or field", async () => {
  const envelope = await encryptSecretValue("value", {
    env,
    hashKey: "secrets:demo",
    fieldName: "TOKEN",
    random: deterministicRandomFactory(),
  });

  await assert.rejects(
    decryptSecretValue(envelope, {
      env,
      hashKey: "secrets:other",
      fieldName: "TOKEN",
    }),
    { code: "secret_decrypt_failed" }
  );
  await assert.rejects(
    decryptSecretValue(envelope, {
      env,
      hashKey: "secrets:demo",
      fieldName: "OTHER",
    }),
    { code: "secret_decrypt_failed" }
  );
});

test("secret envelope requires explicit local provider configuration", async () => {
  await assert.rejects(
    encryptSecretValue("value", {
      env: {},
      hashKey: "secrets:demo",
      fieldName: "TOKEN",
    }),
    { code: "secret_encryption_unconfigured" }
  );
});

test("secret envelope rejects unprefixed values", async () => {
  await assert.rejects(
    decryptSecretValue("plain-secret", {
      env,
      hashKey: "secrets:demo",
      fieldName: "TOKEN",
    }),
    { code: "secret_not_encrypted" }
  );
});

test("secret envelope rejects unknown kid", async () => {
  const envelope = await encryptSecretValue("value", {
    env,
    hashKey: "secrets:demo",
    fieldName: "TOKEN",
    random: deterministicRandomFactory(),
  });

  await assert.rejects(
    decryptSecretValue(envelope, {
      env: { ...env, SECRET_ENVELOPE_KID: "local:test:secret-envelope:v2" },
      hashKey: "secrets:demo",
      fieldName: "TOKEN",
    }),
    { code: "unknown_kid" }
  );
});

test("secret envelope reports invalid local provider key as configuration error", async () => {
  await assert.rejects(
    encryptSecretValue("value", {
      env: {
        SECRET_ENVELOPE_LOCAL_KEY_B64: "not-base64",
        SECRET_ENVELOPE_KID: "local:test:secret-envelope:v1",
      },
      hashKey: "secrets:demo",
      fieldName: "TOKEN",
    }),
    { code: "secret_encryption_unconfigured" }
  );
});

test("secret envelope rejects unknown JSON fields like redis-proxy", async () => {
  const envelope = await encryptSecretValue("value", {
    env,
    hashKey: "secrets:demo",
    fieldName: "TOKEN",
    random: deterministicRandomFactory(),
  });
  const parsed = JSON.parse(envelope.slice(SECRET_ENVELOPE_PREFIX.length));
  const withExtra = `${SECRET_ENVELOPE_PREFIX}${JSON.stringify({ ...parsed, extra: "ignored?" })}`;

  await assert.rejects(
    decryptSecretValue(withExtra, {
      env,
      hashKey: "secrets:demo",
      fieldName: "TOKEN",
    }),
    { code: "invalid_envelope" }
  );
});

test("secret envelope rejects duplicate JSON fields like redis-proxy", async () => {
  const envelope = await encryptSecretValue("value", {
    env,
    hashKey: "secrets:demo",
    fieldName: "TOKEN",
    random: deterministicRandomFactory(),
  });
  const json = envelope.slice(SECRET_ENVELOPE_PREFIX.length);
  const duplicated = `${SECRET_ENVELOPE_PREFIX}${json.replace("\"v\":1", "\"v\":999,\"v\":1")}`;

  await assert.rejects(
    decryptSecretValue(duplicated, {
      env,
      hashKey: "secrets:demo",
      fieldName: "TOKEN",
    }),
    { code: "invalid_envelope" }
  );
});
