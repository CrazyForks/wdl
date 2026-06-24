/** @param {unknown} s */
export function xmlEscape(s) {
  const value = String(s);
  if (!/[&<>"']/.test(value)) return value;
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

/** @param {unknown} s */
export function xmlUnescape(s) {
  const value = String(s);
  if (!value.includes("&")) return value;
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (entity, h) => decodeXmlCodePoint(entity, h, 16))
    .replace(/&#(\d+);/g, (entity, d) => decodeXmlCodePoint(entity, d, 10))
    .replaceAll("&amp;", "&");
}

/**
 * @param {string} entity
 * @param {string} value
 * @param {number} radix
 */
function decodeXmlCodePoint(entity, value, radix) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
  return String.fromCodePoint(codePoint);
}

/** @param {unknown} name */
export function xmlLocalName(name) {
  return String(name).split(":").pop();
}

/** @param {string} xml @param {string} tag */
export function listXmlTagValues(xml, tag) {
  const escapedTag = RegExp.escape(tag);
  const tagName = `((?:[A-Za-z_][A-Za-z0-9_.-]*:)?${escapedTag})`;
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/\\1>`, "g");
  return [...xml.matchAll(re)].map((m) => xmlUnescape(m[2]));
}

/** @param {string} xml @param {string} tag */
export function xmlTagValueIsTrue(xml, tag) {
  return listXmlTagValues(xml, tag).some((value) => value.trim() === "true");
}

/**
 * @param {string} body
 * @param {Set<string>} tags
 * @returns {Record<string, string>}
 */
export function collectXmlFields(body, tags) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const match of body.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)>([\s\S]*?)<\/\1>/g)) {
    const tag = xmlLocalName(match[1]);
    if (tag && tags.has(tag)) fields[tag] = xmlUnescape(match[2]);
  }
  return fields;
}
