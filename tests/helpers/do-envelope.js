const decoder = new TextDecoder();

/** @param {Uint8Array | ArrayBuffer} body */
function doEnvelopeBytes(body) {
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

/**
 * @template [T=Record<string, unknown>]
 * @param {Uint8Array | ArrayBuffer} body
 * @returns {{ metadata: T, bodyBytes: Uint8Array }}
 */
export function decodeDoEnvelope(body) {
  const bytes = doEnvelopeBytes(body);
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  const metadata = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metadataLength)));
  return {
    metadata: /** @type {T} */ (metadata),
    bodyBytes: bytes.subarray(4 + metadataLength),
  };
}

/**
 * @template [T=Record<string, unknown>]
 * @param {Uint8Array | ArrayBuffer} body
 * @returns {T}
 */
export function decodeDoEnvelopeMetadata(body) {
  return /** @type {T} */ (decodeDoEnvelope(body).metadata);
}
