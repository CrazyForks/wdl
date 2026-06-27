// @ts-nocheck

// node_modules/@wdl-dev/aws-sigv4/dist/index.js
var textEncoder = new TextEncoder();
var AUTHORIZATION_HEADER = "authorization";
var HOST_HEADER = "host";
var AMZ_CONTENT_SHA256_HEADER = "x-amz-content-sha256";
var AMZ_DATE_HEADER = "x-amz-date";
var AMZ_SECURITY_TOKEN_HEADER = "x-amz-security-token";
var CONTENT_TYPE_HEADER = "content-type";
var MANDATORY_SIGNED_HEADERS = /* @__PURE__ */ new Set([
  HOST_HEADER,
  AMZ_CONTENT_SHA256_HEADER,
  AMZ_DATE_HEADER,
  AMZ_SECURITY_TOKEN_HEADER
]);
var DEFAULT_UNSIGNABLE_HEADERS = /* @__PURE__ */ new Set([
  AUTHORIZATION_HEADER,
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "presigned-expires",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "x-amzn-trace-id"
]);
var RFC3986_EXTRA_ESCAPE_RE = /[!'()*]/g;
var LOWER_HEX = "0123456789abcdef";
var AWS_ALGORITHM = "AWS4-HMAC-SHA256";
var AWS_REQUEST = "aws4_request";
var UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
var CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
var WHITESPACE_RE = /\s/u;
var AUTH_PARAM_SEPARATOR_RE = /[,=;]/u;
var HTTP_METHOD_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
var SIGNING_DATE_ERROR = "signingDate must be a valid Date, ISO-8601 string, or YYYYMMDDTHHMMSSZ string";
var IDEMPOTENT_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
var CLIENT_SIGNING_OPTION_KEYS = /* @__PURE__ */ new Set([
  "service",
  "region",
  "signingDate",
  "unsignedPayload",
  "signAllHeaders",
  "unsignableHeaders"
]);
var UNSIGNABLE_HEADER_SNAPSHOTS = /* @__PURE__ */ new WeakMap();
var SigV4Client = class {
  accessKeyId;
  secretAccessKey;
  secretAccessKeyHash;
  sessionToken;
  service;
  region;
  cache;
  retries;
  initialRetryDelayMs;
  maxRetryDelayMs;
  unsignedPayload;
  signAllHeaders;
  unsignableHeaders;
  fetchFn;
  constructor(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("SigV4Client options are required");
    }
    requireCredentialComponent(options.accessKeyId, "accessKeyId");
    requireSecretAccessKey(options.secretAccessKey);
    requireCredentialComponent(options.service, "service");
    requireCredentialComponent(options.region, "region");
    if (options.sessionToken !== void 0) {
      requireString(options.sessionToken, "sessionToken");
      rejectControlChars(options.sessionToken, "sessionToken");
      rejectSurroundingWhitespace(options.sessionToken, "sessionToken");
    }
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.sessionToken = options.sessionToken;
    this.service = options.service;
    this.region = options.region;
    this.cache = requireSigningCache(options.cache, "cache") ?? /* @__PURE__ */ new Map();
    this.retries = requireNonNegativeInteger(options.retries ?? 0, "retries");
    this.initialRetryDelayMs = requireNonNegativeFiniteNumber(options.initialRetryDelayMs ?? 50, "initialRetryDelayMs");
    this.maxRetryDelayMs = requireNonNegativeFiniteNumber(options.maxRetryDelayMs ?? 5e3, "maxRetryDelayMs");
    this.unsignedPayload = optionalBoolean(options.unsignedPayload, "unsignedPayload");
    this.signAllHeaders = optionalBoolean(options.signAllHeaders, "signAllHeaders");
    this.unsignableHeaders = normalizeUnsignableHeaders(options.unsignableHeaders, "unsignableHeaders");
    const fetchFn = options.fetch === void 0 ? globalThis.fetch : options.fetch;
    if (typeof fetchFn !== "function") {
      throw new TypeError(options.fetch === void 0 ? "fetch is not available" : "fetch must be a function");
    }
    this.fetchFn = bindFetch(fetchFn);
  }
  async sign(input, init = {}) {
    const requestInit = input instanceof Request ? mergeDefinedRequestInit(requestInitFromRequest(input), init) : { ...init };
    const signingOptions = normalizeClientSigningOptions(requestInit.signing);
    delete requestInit.signing;
    let url;
    let method = requestInit.method;
    let headers = requestInit.headers;
    let body = requestInit.body;
    if (input instanceof Request) {
      url = input.url;
      if (method === void 0)
        method = input.method;
      headers = mergeHeaders(input.headers, headers);
      if (body === void 0 && input.body) {
        body = input.clone().body;
      }
    } else {
      url = input;
    }
    const normalizedMethod = normalizeMethod(method === void 0 ? defaultMethod(body) : method);
    rejectRequestBodyForGetHead(normalizedMethod, body);
    const service = signingOptions.service ?? this.service;
    const requestUrl = parseRequestUrl(url);
    assertParsedRequestCanRepresentSignedUrl(requestUrl.pathname, service);
    const signed = await signAwsRequestInternal({
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      service,
      region: signingOptions.region ?? this.region,
      cache: this.cache,
      unsignedPayload: signingOptions.unsignedPayload ?? this.unsignedPayload,
      signAllHeaders: signingOptions.signAllHeaders ?? this.signAllHeaders,
      unsignableHeaders: signingOptions.unsignableHeaders ?? this.unsignableHeaders,
      signingDate: signingOptions.signingDate,
      method: normalizedMethod,
      url,
      headers,
      body
    }, await this.getSecretAccessKeyHash(), requestUrl);
    assertRequestCanRepresentSignedUrl(signed.url, service);
    const signedInit = requestInitForSignedRequest(requestInit, signed);
    try {
      return new Request(signed.url, signedInit);
    } catch (err) {
      if (err instanceof TypeError) {
        return new Request(signed.url, {
          ...signedInit,
          duplex: "half"
        });
      }
      throw err;
    }
  }
  async fetch(input, init = {}) {
    const requestInit = {
      ...init,
      signing: normalizeClientSigningOptions(init.signing)
    };
    const method = methodForRequest(input, requestInit);
    rejectRequestBodyForGetHead(method, requestBodyForInput(input, requestInit));
    const service = requestInit.signing.service ?? this.service;
    assertRequestCanRepresentSignedUrl(input instanceof Request ? input.url : input, service);
    const replayBody = this.retries > 0 && isIdempotentMethod(method);
    const retryInit = await reusableRequestInitForInput(input, requestInit, this.service, this.unsignedPayload, replayBody);
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const fetchFn = this.fetchFn;
      const request = await this.sign(input, retryInit);
      let response;
      try {
        response = await fetchFn(request);
      } catch (err) {
        if (attempt === this.retries || !isIdempotentMethod(request.method) || isAbortError(err, request)) {
          throw err;
        }
        await sleep(Math.random() * this.retryDelayMs(attempt), request.signal);
        continue;
      }
      const retryableResponse = isIdempotentMethod(request.method) && (response.status >= 500 || response.status === 429);
      if (attempt === this.retries || !retryableResponse) {
        return response;
      }
      await cancelResponseBody(response);
      if (request.signal.aborted)
        throw abortReason(request.signal);
      await sleep(Math.random() * this.retryDelayMs(attempt), request.signal);
    }
    throw new Error("unreachable retry loop exit");
  }
  getSecretAccessKeyHash() {
    this.secretAccessKeyHash ??= sha256Hex(this.secretAccessKey);
    return this.secretAccessKeyHash;
  }
  retryDelayMs(attempt) {
    return Math.min(this.maxRetryDelayMs, this.initialRetryDelayMs * 2 ** attempt);
  }
};
async function signAwsRequest(options) {
  return signAwsRequestInternal(options);
}
async function signAwsRequestInternal(options, secretAccessKeyHash, parsedRequestUrl) {
  if (!options || typeof options !== "object") {
    throw new TypeError("signAwsRequest options are required");
  }
  requireCredentialComponent(options.accessKeyId, "accessKeyId");
  requireSecretAccessKey(options.secretAccessKey);
  requireCredentialComponent(options.service, "service");
  requireCredentialComponent(options.region, "region");
  if (options.sessionToken !== void 0) {
    requireString(options.sessionToken, "sessionToken");
    rejectControlChars(options.sessionToken, "sessionToken");
    rejectSurroundingWhitespace(options.sessionToken, "sessionToken");
  }
  const cache = requireSigningCache(options.cache, "cache");
  if (options.url == null)
    throw new TypeError("url is a required option");
  const requestUrl = parsedRequestUrl ?? parseRequestUrl(options.url);
  const url = requestUrl.url;
  const method = normalizeMethod(options.method === void 0 ? defaultMethod(options.body) : options.method);
  const headers = new Headers(options.headers || {});
  rejectEmptyHeader(headers, AMZ_CONTENT_SHA256_HEADER);
  const unsignedPayload = optionalBoolean(options.unsignedPayload, "unsignedPayload") ?? options.service === "s3";
  const signAllHeaders = optionalBoolean(options.signAllHeaders, "signAllHeaders");
  const unsignableHeaders = snapshotUnsignableHeaders(options, options.unsignableHeaders, "unsignableHeaders");
  if (unsignedPayload && !headers.has(AMZ_CONTENT_SHA256_HEADER)) {
    headers.set(AMZ_CONTENT_SHA256_HEADER, UNSIGNED_PAYLOAD);
  }
  const preparedBody = await prepareBody(options.body, headers, !unsignedPayload && !headers.has(AMZ_CONTENT_SHA256_HEADER));
  if (!unsignedPayload && !headers.has(AMZ_CONTENT_SHA256_HEADER) && hasRequestBody(options.body)) {
    headers.set(AMZ_CONTENT_SHA256_HEADER, await sha256Hex(preparedBody.bytes));
  }
  const amzDate = formatAmzDate(options.signingDate ?? /* @__PURE__ */ new Date());
  const date = amzDate.slice(0, 8);
  const credentialScope = `${date}/${options.region}/${options.service}/${AWS_REQUEST}`;
  headers.set(AMZ_DATE_HEADER, amzDate);
  headers.set(HOST_HEADER, url.host);
  if (options.sessionToken)
    headers.set(AMZ_SECURITY_TOKEN_HEADER, options.sessionToken);
  const canonicalPayloadHash = await canonicalPayloadHashValue(headers, preparedBody.bytes, unsignedPayload);
  if (options.service === "s3" && !headers.has(AMZ_CONTENT_SHA256_HEADER)) {
    headers.set(AMZ_CONTENT_SHA256_HEADER, canonicalPayloadHash);
  }
  const { canonicalHeaders, signedHeaders } = canonicalHeaderBlock(url, headers, {
    signAllHeaders,
    unsignableHeaders
  });
  const canonicalRequest = [
    method,
    canonicalPathname(requestUrl.pathname),
    canonicalQuery(requestUrl.search),
    `${canonicalHeaders}
`,
    signedHeaders,
    canonicalPayloadHash
  ].join("\n");
  const stringToSign = [
    AWS_ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = await signatureHex({
    secretAccessKey: options.secretAccessKey,
    secretAccessKeyHash,
    date,
    region: options.region,
    service: options.service,
    stringToSign,
    cache
  });
  headers.set(AUTHORIZATION_HEADER, [
    `${AWS_ALGORITHM} Credential=${options.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(", "));
  return {
    method,
    url: requestUrl.href,
    headers,
    body: preparedBody.body
  };
}
function parseRequestUrl(input) {
  const raw = String(input);
  if (typeof input === "string" && /\s/u.test(raw)) {
    throw new TypeError("url must not contain unescaped whitespace");
  }
  if (typeof input === "string" && raw.includes("\\")) {
    throw new TypeError("url must not contain backslashes");
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("url must use http: or https:");
  }
  if (url.username || url.password) {
    throw new TypeError("url must not include username or password");
  }
  if (typeof input !== "string") {
    if (hasMalformedPercentEncoding(url.pathname) || hasMalformedPercentEncoding(url.search)) {
      throw new TypeError("url must not contain malformed percent encoding");
    }
    return {
      url,
      href: stripUrlFragment(url.toString()),
      pathname: url.pathname || "/",
      search: url.search
    };
  }
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)?(\?[^#]*)?/u.exec(raw);
  if (!match) {
    throw new TypeError("url must include scheme://host");
  }
  const pathname = match[1] || "/";
  const search = match[2] || "";
  if (hasMalformedPercentEncoding(pathname) || hasMalformedPercentEncoding(search)) {
    throw new TypeError("url must not contain malformed percent encoding");
  }
  return {
    url,
    href: `${url.protocol}//${url.host}${pathname}${search}`,
    pathname,
    search
  };
}
function stripUrlFragment(value) {
  const index = value.indexOf("#");
  return index === -1 ? value : value.slice(0, index);
}
function mergeHeaders(base, override) {
  const headers = new Headers(base);
  if (override) {
    new Headers(override).forEach((value, name) => headers.set(name, value));
  }
  return headers;
}
function mergeDefinedRequestInit(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== void 0) {
      out[key] = value;
    }
  }
  return out;
}
function rejectEmptyHeader(headers, name) {
  if (headers.get(name) === "") {
    throw new TypeError(`${name} must not be empty`);
  }
}
function requestInitFromRequest(request) {
  const init = {
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
    window: null
  };
  const duplex = request.duplex;
  if (duplex === "half") {
    return { ...init, duplex };
  }
  return init;
}
function normalizeClientSigningOptions(options) {
  if (options === void 0)
    return {};
  if (options === null || typeof options !== "object") {
    throw new TypeError("init.signing must be an object");
  }
  for (const key of Object.keys(options)) {
    if (!CLIENT_SIGNING_OPTION_KEYS.has(key)) {
      throw new TypeError(`init.signing.${key} cannot override client credentials or transport options`);
    }
  }
  const record = options;
  const normalized = { ...record };
  const unsignedPayload = optionalBoolean(record.unsignedPayload, "init.signing.unsignedPayload");
  const signAllHeaders = optionalBoolean(record.signAllHeaders, "init.signing.signAllHeaders");
  const unsignableHeaders = snapshotUnsignableHeaders(options, record.unsignableHeaders, "init.signing.unsignableHeaders");
  if (unsignedPayload === void 0) {
    delete normalized.unsignedPayload;
  } else {
    normalized.unsignedPayload = unsignedPayload;
  }
  if (signAllHeaders === void 0) {
    delete normalized.signAllHeaders;
  } else {
    normalized.signAllHeaders = signAllHeaders;
  }
  if (unsignableHeaders === void 0) {
    delete normalized.unsignableHeaders;
  } else {
    normalized.unsignableHeaders = unsignableHeaders;
  }
  return normalized;
}
function requestBodyForInput(input, init) {
  if (init.body !== void 0)
    return init.body;
  return input instanceof Request ? input.body : void 0;
}
function methodForRequest(input, init) {
  if (init.method !== void 0)
    return normalizeMethod(init.method);
  if (input instanceof Request)
    return normalizeMethod(input.method);
  return defaultMethod(init.body);
}
function defaultMethod(body) {
  return hasRequestBody(body) ? "POST" : "GET";
}
function normalizeMethod(method) {
  if (typeof method !== "string" || !HTTP_METHOD_RE.test(method)) {
    throw new TypeError("method must be a valid HTTP token");
  }
  return method.toUpperCase();
}
function isIdempotentMethod(method) {
  return IDEMPOTENT_METHODS.has(method);
}
function rejectRequestBodyForGetHead(method, body) {
  if ((method === "GET" || method === "HEAD") && hasRequestBody(body)) {
    throw new TypeError("GET and HEAD requests with a body require signAwsRequest");
  }
}
function hasRequestBody(body) {
  return body !== void 0 && body !== null;
}
function isAbortError(err, request) {
  return request.signal.aborted || err instanceof DOMException && err.name === "AbortError";
}
function assertRequestCanRepresentSignedUrl(url, service) {
  assertParsedRequestCanRepresentSignedUrl(parseRequestUrl(url).pathname, service);
}
function assertParsedRequestCanRepresentSignedUrl(pathname, service) {
  if (hasDotPathSegment(pathname)) {
    throw new TypeError(`SigV4Client cannot represent ${service} URLs with dot segments; use signAwsRequest`);
  }
}
function hasDotPathSegment(pathname) {
  return pathname.split("/").some((segment) => {
    const value = segment.replace(/%2e/giu, ".");
    return value === "." || value === "..";
  });
}
function hasMalformedPercentEncoding(value) {
  return /%(?![0-9A-Fa-f]{2})/u.test(value);
}
async function reusableRequestInitForInput(input, init, defaultService, defaultUnsignedPayload, replayBody) {
  if (!(input instanceof Request)) {
    return reusableRequestInit(init, defaultService, defaultUnsignedPayload, replayBody);
  }
  const inputInit = {
    ...init,
    method: init.method ?? input.method,
    headers: mergeHeaders(input.headers, init.headers)
  };
  if (init.body === void 0 && input.body) {
    inputInit.body = input.clone().body;
  }
  return reusableRequestInit(inputInit, defaultService, defaultUnsignedPayload, replayBody);
}
async function reusableRequestInit(init, defaultService, defaultUnsignedPayload, replayBody) {
  const headers = new Headers(init.headers || {});
  const service = init.signing?.service ?? defaultService;
  const unsignedPayload = init.signing?.unsignedPayload ?? defaultUnsignedPayload ?? service === "s3";
  const materializeBody = replayBody && (init.body instanceof FormData || init.body instanceof ReadableStream);
  const hashPayload = hasRequestBody(init.body) && !unsignedPayload && !headers.has(AMZ_CONTENT_SHA256_HEADER);
  if (!materializeBody && !hashPayload) {
    return init;
  }
  const body = await prepareBody(init.body, headers, materializeBody || hashPayload);
  if (hashPayload) {
    headers.set(AMZ_CONTENT_SHA256_HEADER, await sha256Hex(body.bytes));
  }
  const out = {
    ...init,
    headers
  };
  if (body.body !== void 0)
    out.body = body.body;
  return out;
}
function requestInitForSignedRequest(base, signed) {
  const out = {
    ...base,
    method: signed.method,
    headers: signed.headers
  };
  if (signed.body !== void 0)
    out.body = signed.body;
  return out;
}
function bindFetch(fetchFn) {
  return Object.is(fetchFn, globalThis.fetch) ? fetchFn.bind(globalThis) : fetchFn;
}
function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
function requireCredentialComponent(value, name) {
  requireString(value, name);
  rejectControlChars(value, name);
  rejectWhitespace(value, name);
  rejectAuthorizationParamSeparators(value, name);
  if (value.includes("/")) {
    throw new TypeError(`${name} must not contain /`);
  }
}
function requireSecretAccessKey(value) {
  requireString(value, "secretAccessKey");
  rejectControlChars(value, "secretAccessKey");
}
function rejectControlChars(value, name) {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new TypeError(`${name} must not contain control characters`);
  }
}
function rejectAuthorizationParamSeparators(value, name) {
  if (AUTH_PARAM_SEPARATOR_RE.test(value)) {
    throw new TypeError(`${name} must not contain Authorization parameter separators`);
  }
}
function rejectWhitespace(value, name) {
  if (WHITESPACE_RE.test(value)) {
    throw new TypeError(`${name} must not contain whitespace`);
  }
}
function rejectSurroundingWhitespace(value, name) {
  if (value.trim() !== value) {
    throw new TypeError(`${name} must not contain leading or trailing whitespace`);
  }
}
function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}
function requireNonNegativeFiniteNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}
function optionalBoolean(value, name) {
  if (value === void 0)
    return void 0;
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}
function formatAmzDate(value) {
  if (typeof value === "string" && /^\d{8}T\d{6}Z$/u.test(value)) {
    if (!isValidCompactAmzDate(value)) {
      throw new TypeError(SIGNING_DATE_ERROR);
    }
    return value;
  }
  if (typeof value === "string" && !ISO_DATE_RE.test(value)) {
    throw new TypeError(SIGNING_DATE_ERROR);
  }
  if (typeof value === "string" && !isValidIsoDate(value)) {
    throw new TypeError(SIGNING_DATE_ERROR);
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (!(date instanceof Date)) {
    throw new TypeError(SIGNING_DATE_ERROR);
  }
  if (Number.isNaN(dateTimeValue(date))) {
    throw new TypeError(SIGNING_DATE_ERROR);
  }
  const amzDate = Date.prototype.toISOString.call(date).replace(/[:-]|\.\d{3}/g, "");
  if (!/^\d{8}T\d{6}Z$/u.test(amzDate) || !isValidCompactAmzDate(amzDate)) {
    throw new TypeError(SIGNING_DATE_ERROR);
  }
  return amzDate;
}
function dateTimeValue(date) {
  try {
    return Date.prototype.getTime.call(date);
  } catch {
    throw new TypeError(SIGNING_DATE_ERROR);
  }
}
function isValidIsoDate(value) {
  const match = ISO_DATE_RE.exec(value);
  if (!match)
    return false;
  const [datePart, timePart] = value.split("T");
  const [yearText, monthText, dayText] = datePart.split("-");
  const [hourText, minuteText, secondText] = timePart.split(/[.:Z+-]/u);
  return isValidDateParts(Number(yearText), Number(monthText), Number(dayText), Number(hourText), Number(minuteText), Number(secondText));
}
function isValidCompactAmzDate(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(9, 11));
  const minute = Number(value.slice(11, 13));
  const second = Number(value.slice(13, 15));
  return isValidDateParts(year, month, day, hour, minute, second);
}
function isValidDateParts(year, month, day, hour, minute, second) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}
function canonicalHeaderBlock(url, headers, options) {
  const userUnsignable = new Set((options.unsignableHeaders || []).map((value) => value.toLowerCase()));
  const signable = [.../* @__PURE__ */ new Set([HOST_HEADER, ...headers.keys()])].filter((header) => header !== AUTHORIZATION_HEADER).filter((header) => {
    if (MANDATORY_SIGNED_HEADERS.has(header))
      return true;
    if (userUnsignable.has(header))
      return false;
    return options.signAllHeaders || !DEFAULT_UNSIGNABLE_HEADERS.has(header);
  }).sort();
  const canonicalHeaders = signable.map((header) => {
    const value = header === HOST_HEADER ? url.host : canonicalHeaderValue(headers.get(header) || "");
    return `${header}:${value}`;
  }).join("\n");
  return {
    canonicalHeaders,
    signedHeaders: signable.join(";")
  };
}
function canonicalHeaderValue(value) {
  const normalized = [];
  let pendingSpace = false;
  for (const char of value) {
    if (char === " " || char === "	") {
      if (normalized.length > 0)
        pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      normalized.push(" ");
      pendingSpace = false;
    }
    normalized.push(char);
  }
  return normalized.join("");
}
function normalizeUnsignableHeaders(value, name) {
  if (value === void 0)
    return void 0;
  if (value === null || typeof value === "string" || typeof value[Symbol.iterator] !== "function") {
    throw new TypeError(`${name} must be an iterable of header names`);
  }
  return [...value].map((header) => {
    if (typeof header !== "string" || header.length === 0) {
      throw new TypeError(`${name} must contain only non-empty strings`);
    }
    return header;
  });
}
function snapshotUnsignableHeaders(owner, source, name) {
  if (source === void 0)
    return void 0;
  if (!isIterable(source))
    return normalizeUnsignableHeaders(source, name);
  if (!isOneShotIterable(source))
    return normalizeUnsignableHeaders(source, name);
  const cached = UNSIGNABLE_HEADER_SNAPSHOTS.get(owner);
  if (cached && cached.source === source)
    return cached.value;
  const value = normalizeUnsignableHeaders(source, name);
  UNSIGNABLE_HEADER_SNAPSHOTS.set(owner, { source, value });
  return value;
}
function isOneShotIterable(value) {
  return Object.is(value[Symbol.iterator](), value);
}
function isIterable(value) {
  return value !== null && typeof value !== "string" && typeof value[Symbol.iterator] === "function";
}
function requireSigningCache(value, name) {
  if (value === void 0)
    return void 0;
  if (value === null || typeof value !== "object" || value instanceof WeakMap || typeof value.get !== "function" || typeof value.set !== "function") {
    throw new TypeError(`${name} must be a Map-like cache`);
  }
  return value;
}
function canonicalQuery(search) {
  if (search === "")
    return "";
  return search.slice(1).split("&").filter((part) => part.length > 0).map((part) => {
    const separator = part.indexOf("=");
    const key = separator === -1 ? part : part.slice(0, separator);
    const value = separator === -1 ? "" : part.slice(separator + 1);
    return [canonicalQueryComponent(key), canonicalQueryComponent(value)];
  }).sort(([ak, av], [bk, bv]) => compareCodepoint(ak, bk) || compareCodepoint(av, bv)).map(([key, value]) => `${key}=${value}`).join("&");
}
function canonicalQueryComponent(value) {
  return canonicalUriComponent(value, false);
}
function compareCodepoint(left, right) {
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return 0;
}
function encodeRfc3986(value) {
  return value.replace(RFC3986_EXTRA_ESCAPE_RE, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function canonicalPathname(pathname) {
  return canonicalUriComponent(pathname, true);
}
function canonicalUriComponent(value, preserveSlash) {
  let out = "";
  for (let index = 0; index < value.length; ) {
    const char = value[index];
    if (preserveSlash && char === "/") {
      out += "/";
      index += 1;
      continue;
    }
    if (char === "%" && isHexPair(value, index + 1)) {
      const hex2 = value.slice(index + 1, index + 3).toUpperCase();
      const byte = parseInt(hex2, 16);
      out += isUnreservedByte(byte) ? String.fromCharCode(byte) : `%${hex2}`;
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === void 0)
      break;
    const charValue = String.fromCodePoint(codePoint);
    try {
      out += encodeRfc3986(encodeURIComponent(charValue));
    } catch (err) {
      if (err instanceof URIError) {
        throw new TypeError("url must not contain invalid UTF-16");
      }
      throw err;
    }
    index += charValue.length;
  }
  return out;
}
function isHexPair(value, index) {
  return /^[0-9A-Fa-f]{2}$/u.test(value.slice(index, index + 2));
}
function isUnreservedByte(byte) {
  return byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 45 || byte === 46 || byte === 95 || byte === 126;
}
async function canonicalPayloadHashValue(headers, body, unsignedPayload) {
  const explicit = headers.get(AMZ_CONTENT_SHA256_HEADER);
  if (explicit)
    return explicit;
  if (unsignedPayload)
    return UNSIGNED_PAYLOAD;
  return sha256Hex(body);
}
async function prepareBody(body, headers, materialize) {
  if (body == null) {
    return { body, bytes: new Uint8Array() };
  }
  if (body instanceof FormData) {
    rejectManualFormDataContentType(headers);
    const request = new Request("https://aws-sigv4.invalid/", { method: "POST", body });
    const contentType = request.headers.get(CONTENT_TYPE_HEADER);
    if (contentType)
      headers.set(CONTENT_TYPE_HEADER, contentType);
    const bytes2 = new Uint8Array(await request.arrayBuffer());
    return { body: bytes2, bytes: bytes2 };
  }
  setGeneratedContentType(body, headers);
  if (!materialize) {
    return { body, bytes: new Uint8Array() };
  }
  if (body instanceof ReadableStream) {
    const bytes2 = new Uint8Array(await new Response(body).arrayBuffer());
    return { body: bytes2, bytes: bytes2 };
  }
  const bytes = await bodyBytes(body);
  return { body, bytes };
}
function rejectManualFormDataContentType(headers) {
  if (headers.has(CONTENT_TYPE_HEADER)) {
    throw new TypeError("FormData content-type must be generated by the runtime");
  }
}
function setGeneratedContentType(body, headers) {
  if (headers.has(CONTENT_TYPE_HEADER))
    return;
  if (typeof body === "string") {
    headers.set(CONTENT_TYPE_HEADER, "text/plain;charset=UTF-8");
  } else if (body instanceof URLSearchParams) {
    headers.set(CONTENT_TYPE_HEADER, "application/x-www-form-urlencoded;charset=UTF-8");
  } else if (body instanceof Blob && body.type) {
    headers.set(CONTENT_TYPE_HEADER, body.type);
  }
}
async function bodyBytes(body) {
  if (typeof body === "string")
    return textEncoder.encode(body);
  if (body instanceof Uint8Array)
    return body;
  if (body instanceof ArrayBuffer)
    return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams)
    return textEncoder.encode(body.toString());
  if (body instanceof Blob)
    return new Uint8Array(await body.arrayBuffer());
  throw new TypeError("body must be a string, Blob, URLSearchParams, ArrayBuffer, or ArrayBufferView");
}
async function signatureHex(options) {
  const secretAccessKeyHash = options.secretAccessKeyHash ?? await sha256Hex(options.secretAccessKey);
  const cacheKey = ["sigv4", secretAccessKeyHash, options.date, options.region, options.service].join(",");
  let signingKey = options.cache?.get(cacheKey);
  if (!signingKey) {
    const kDate = await hmac(`AWS4${options.secretAccessKey}`, options.date);
    const kRegion = await hmac(kDate, options.region);
    const kService = await hmac(kRegion, options.service);
    signingKey = await hmac(kService, AWS_REQUEST);
    options.cache?.set(cacheKey, signingKey);
  }
  return hex(await hmac(signingKey, options.stringToSign));
}
async function sha256Hex(value) {
  const bytes = cryptoBufferSource(value);
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
function cryptoBufferSource(value) {
  if (typeof value === "string")
    return textEncoder.encode(value);
  if (value instanceof ArrayBuffer)
    return value;
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return value;
  }
  return new Uint8Array(value);
}
async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", typeof key === "string" ? textEncoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(value));
}
function hex(input) {
  const bytes = new Uint8Array(input);
  let out = "";
  for (const byte of bytes) {
    out += hexNibble(byte >>> 4);
    out += hexNibble(byte & 15);
  }
  return out;
}
function hexNibble(value) {
  return LOWER_HEX.charAt(value);
}
function sleep(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted)
    return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let timeout;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}
function abortReason(signal) {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}
async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
  }
}
export {
  SigV4Client,
  signAwsRequest
};
