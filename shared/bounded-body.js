const utf8Decoder = new TextDecoder();

export class BodyTooLargeError extends Error {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedBytes(request, maxBytes) {
  const contentLength = request.headers.get("content-length");
  if (contentLength != null && contentLength !== "") {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * @param {Request} request
 * @param {number} maxBytes
 */
export async function readBoundedText(request, maxBytes) {
  return utf8Decoder.decode(await readBoundedBytes(request, maxBytes));
}
