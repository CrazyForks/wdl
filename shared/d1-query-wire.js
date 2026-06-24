import { normalizeD1Param } from "shared-d1-params";
import { setDataField } from "shared-d1-data-field";

export const D1_QUERY_CONTENT_TYPE = "application/vnd.wdl.d1-query";
export const D1_QUERY_RESPONSE_CONTENT_TYPE = "application/vnd.wdl.d1-query-response";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * @typedef {string | number | number[] | null} D1QueryParam
 * @typedef {Uint8Array<ArrayBufferLike>} ByteArray
 * @typedef {{ sql?: unknown, params?: unknown[] }} D1QueryStatementInput
 * @typedef {{ sql: string, params: D1QueryParam[] }} D1QueryStatement
 * @typedef {{
 *   namespace?: unknown,
 *   databaseId?: unknown,
 *   binding?: unknown,
 *   mode?: unknown,
 *   statements?: D1QueryStatementInput[],
 * }} D1QueryRequestInput
 * @typedef {{
 *   namespace: string,
 *   databaseId: string,
 *   binding: string | null,
 *   mode: string | undefined,
 *   statements: D1QueryStatement[],
 * }} D1QueryRequest
 */

/** @param {string} value */
function bytesOf(value) {
  return utf8Encoder.encode(value);
}

/** @param {ByteArray[]} chunks */
function concat(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** @param {number | bigint} value */
function varint(value) {
  let n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid varint");
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Uint8Array.from(out);
}

/**
 * @param {number} field
 * @param {number} wireType
 */
function tag(field, wireType) {
  return varint(field * 8 + wireType);
}

/**
 * @param {number} field
 * @param {unknown} value
 */
function nonEmptyStringField(field, value) {
  if (value == null || value === "") return [];
  const bytes = bytesOf(String(value));
  return [tag(field, WIRE_LEN), varint(bytes.length), bytes];
}

/**
 * @param {number} field
 * @param {unknown} value
 */
function stringField(field, value) {
  if (value == null) return [];
  const bytes = bytesOf(String(value));
  return [tag(field, WIRE_LEN), varint(bytes.length), bytes];
}

/**
 * @param {number} field
 * @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike> | null | undefined} value
 */
function bytesField(field, value) {
  if (value == null) return [];
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return [tag(field, WIRE_LEN), varint(bytes.length), bytes];
}

/**
 * @param {number} field
 * @param {ByteArray} bytes
 */
function messageField(field, bytes) {
  return [tag(field, WIRE_LEN), varint(bytes.length), bytes];
}

/**
 * @param {number} field
 * @param {number} value
 */
function doubleField(field, value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [tag(field, WIRE_FIXED64), bytes];
}

/**
 * @param {number} field
 * @param {boolean} value
 */
function boolField(field, value) {
  return [tag(field, WIRE_VARINT), varint(value ? 1 : 0)];
}

/**
 * @param {number} field
 * @param {unknown} value
 */
function valueField(field, value) {
  return messageField(field, encodeValue(value));
}

/** @param {unknown} value */
function encodeParam(value) {
  const normalized = normalizeD1Param(value);
  if (normalized == null) return concat(boolField(1, true));
  if (typeof normalized === "number") return concat(doubleField(2, normalized));
  if (typeof normalized === "string") return concat(stringField(3, normalized));
  if (Array.isArray(normalized)) return concat(bytesField(4, Uint8Array.from(normalized)));
  throw new Error(`D1_TYPE_ERROR: Type '${typeof normalized}' not supported for query wire`);
}

/** @param {D1QueryStatementInput | null | undefined} statement */
function encodeStatement(statement) {
  /** @type {ByteArray[]} */
  const chunks = [
    ...nonEmptyStringField(1, statement?.sql),
  ];
  for (const param of statement?.params || []) {
    chunks.push(...messageField(2, encodeParam(param)));
  }
  return concat(chunks);
}

/** @param {D1QueryRequestInput | null | undefined} input */
export function encodeD1QueryRequest(input) {
  /** @type {ByteArray[]} */
  const chunks = [
    ...nonEmptyStringField(1, input?.namespace),
    ...nonEmptyStringField(2, input?.databaseId),
    ...nonEmptyStringField(3, input?.binding),
    ...nonEmptyStringField(4, input?.mode),
  ];
  for (const statement of input?.statements || []) {
    chunks.push(...messageField(5, encodeStatement(statement)));
  }
  return concat(chunks);
}

class Reader {
  /** @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike>} bytes */
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  /** @returns {boolean} */
  done() {
    return this.offset >= this.bytes.length;
  }

  /** @returns {number} */
  readVarint() {
    let shift = 0;
    let out = 0;
    while (this.offset < this.bytes.length && shift <= 49) {
      const byte = this.bytes[this.offset++];
      out += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return out;
      shift += 7;
    }
    throw new Error("truncated varint");
  }

  /** @returns {{ field: number, wireType: number }} */
  readTag() {
    const value = this.readVarint();
    return { field: Math.floor(value / 8), wireType: value % 8 };
  }

  /** @param {number} length */
  readBytes(length) {
    if (length < 0 || this.offset + length > this.bytes.length) throw new Error("truncated length-delimited field");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** @returns {Uint8Array} */
  readLengthDelimited() {
    return this.readBytes(this.readVarint());
  }

  /** @returns {string} */
  readString() {
    return utf8Decoder.decode(this.readLengthDelimited());
  }

  /** @returns {number} */
  readDouble() {
    const bytes = this.readBytes(8);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
  }

  /** @param {number} wireType */
  skip(wireType) {
    if (wireType === WIRE_VARINT) {
      this.readVarint();
      return;
    }
    if (wireType === WIRE_FIXED64) {
      this.readBytes(8);
      return;
    }
    if (wireType === WIRE_LEN) {
      this.readLengthDelimited();
      return;
    }
    throw new Error(`unsupported wire type ${wireType}`);
  }
}

/** @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike>} bytes */
function decodeParam(bytes) {
  const reader = new Reader(bytes);
  let seen = false;
  let value = null;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    seen = true;
    if (field === 1 && wireType === WIRE_VARINT) {
      reader.readVarint();
      value = null;
    } else if (field === 2 && wireType === WIRE_FIXED64) {
      value = reader.readDouble();
    } else if (field === 3 && wireType === WIRE_LEN) {
      value = reader.readString();
    } else if (field === 4 && wireType === WIRE_LEN) {
      value = Array.from(reader.readLengthDelimited());
    } else {
      reader.skip(wireType);
    }
  }
  if (!seen) throw new Error("empty D1 param");
  return value;
}

/** @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike>} bytes */
function decodeStatement(bytes) {
  const reader = new Reader(bytes);
  /** @type {D1QueryStatement} */
  const statement = { sql: "", params: [] };
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WIRE_LEN) {
      statement.sql = reader.readString();
    } else if (field === 2 && wireType === WIRE_LEN) {
      statement.params.push(decodeParam(reader.readLengthDelimited()));
    } else {
      reader.skip(wireType);
    }
  }
  return statement;
}

/** @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike>} bytes */
export function decodeD1QueryRequest(bytes) {
  const reader = new Reader(bytes);
  /** @type {D1QueryRequest} */
  const out = { namespace: "", databaseId: "", binding: null, mode: undefined, statements: [] };
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WIRE_LEN) {
      out.namespace = reader.readString();
    } else if (field === 2 && wireType === WIRE_LEN) {
      out.databaseId = reader.readString();
    } else if (field === 3 && wireType === WIRE_LEN) {
      out.binding = reader.readString();
    } else if (field === 4 && wireType === WIRE_LEN) {
      out.mode = reader.readString();
    } else if (field === 5 && wireType === WIRE_LEN) {
      out.statements.push(decodeStatement(reader.readLengthDelimited()));
    } else {
      reader.skip(wireType);
    }
  }
  return out;
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function encodeObjectEntry(key, value) {
  return concat([
    ...stringField(1, key),
    ...valueField(2, value),
  ]);
}

/** @param {unknown} value */
function encodeValue(value) {
  if (value == null) return concat(boolField(1, true));
  if (typeof value === "boolean") return concat(boolField(2, value));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("D1 response value contains a non-finite number");
    return concat(doubleField(3, value));
  }
  if (typeof value === "string") return concat(stringField(4, value));
  if (value instanceof Uint8Array) return concat(bytesField(5, value));
  if (value instanceof ArrayBuffer) return concat(bytesField(5, new Uint8Array(value)));
  if (ArrayBuffer.isView(value)) {
    return concat(bytesField(5, new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  }
  if (Array.isArray(value)) {
    /** @type {ByteArray[]} */
    const chunks = [
      ...boolField(8, true),
    ];
    for (const item of value) chunks.push(...valueField(6, item));
    return concat(chunks);
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    /** @type {ByteArray[]} */
    const chunks = [
      ...boolField(9, true),
    ];
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      chunks.push(...messageField(7, encodeObjectEntry(key, item)));
    }
    return concat(chunks);
  }
  throw new Error(`D1 response value type ${Object.prototype.toString.call(value)} is not supported`);
}

/** @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike>} bytes @returns {[string, unknown]} */
function decodeObjectEntry(bytes) {
  const reader = new Reader(bytes);
  let key = "";
  /** @type {unknown} */
  let value = null;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WIRE_LEN) {
      key = reader.readString();
    } else if (field === 2 && wireType === WIRE_LEN) {
      value = decodeValue(reader.readLengthDelimited());
    } else {
      reader.skip(wireType);
    }
  }
  return [key, value];
}

/** @param {string} kind */
function assertScalarCompatible(kind) {
  if (kind !== "unset" && kind !== "scalar") {
    throw new Error("mixed D1 response value wire kinds");
  }
}

/** @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike>} bytes */
function decodeValue(bytes) {
  const reader = new Reader(bytes);
  let kind = "unset";
  /** @type {unknown} */
  let value = null;
  while (!reader.done()) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WIRE_VARINT) {
      assertScalarCompatible(kind);
      reader.readVarint();
      kind = "scalar";
      value = null;
    } else if (field === 2 && wireType === WIRE_VARINT) {
      assertScalarCompatible(kind);
      kind = "scalar";
      value = reader.readVarint() !== 0;
    } else if (field === 3 && wireType === WIRE_FIXED64) {
      assertScalarCompatible(kind);
      kind = "scalar";
      value = reader.readDouble();
    } else if (field === 4 && wireType === WIRE_LEN) {
      assertScalarCompatible(kind);
      kind = "scalar";
      value = reader.readString();
    } else if (field === 5 && wireType === WIRE_LEN) {
      assertScalarCompatible(kind);
      kind = "scalar";
      value = Array.from(reader.readLengthDelimited());
    } else if (field === 6 && wireType === WIRE_LEN) {
      if (kind === "unset") {
        kind = "array";
        value = [];
      }
      if (kind !== "array") throw new Error("mixed D1 response value wire kinds");
      /** @type {unknown[]} */ (value).push(decodeValue(reader.readLengthDelimited()));
    } else if (field === 7 && wireType === WIRE_LEN) {
      if (kind === "unset") {
        kind = "object";
        value = {};
      }
      if (kind !== "object") throw new Error("mixed D1 response value wire kinds");
      const [key, item] = decodeObjectEntry(reader.readLengthDelimited());
      setDataField(/** @type {Record<string, unknown>} */ (value), key, item);
    } else if (field === 8 && wireType === WIRE_VARINT) {
      reader.readVarint();
      if (kind === "unset") {
        kind = "array";
        value = [];
      }
      if (kind !== "array") throw new Error("mixed D1 response value wire kinds");
    } else if (field === 9 && wireType === WIRE_VARINT) {
      reader.readVarint();
      if (kind === "unset") {
        kind = "object";
        value = {};
      }
      if (kind !== "object") throw new Error("mixed D1 response value wire kinds");
    } else {
      reader.skip(wireType);
    }
  }
  if (kind === "unset") throw new Error("empty D1 response value");
  return value;
}

/** @param {unknown} payload */
export function encodeD1QueryResponse(payload) {
  return encodeValue(payload);
}

/** @param {ArrayBuffer | ArrayBufferView<ArrayBufferLike>} bytes */
export function decodeD1QueryResponse(bytes) {
  return decodeValue(bytes);
}
