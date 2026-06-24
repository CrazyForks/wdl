const OWNER_ENDPOINT_SERVICE_RE = {
  "d1-runtime": /^d1-runtime(?:-[a-z0-9-]+)?$/,
  "do-runtime": /^do-runtime(?:-[a-z0-9-]+)?$/,
};

const OWNER_ENDPOINT_HEADLESS_RE = {
  "d1-runtime": /^d1-runtime-[0-9]+\.d1-runtime-headless(?:\.[a-z0-9-]+\.svc(?:\.cluster\.local)?)?$/,
  "do-runtime": /^do-runtime-[0-9]+\.do-runtime-headless(?:\.[a-z0-9-]+\.svc(?:\.cluster\.local)?)?$/,
};

/**
 * @param {unknown} endpoint
 * @param {number} port
 * @param {"d1-runtime" | "do-runtime"} serviceName
 * @returns {boolean}
 */
export function validOwnerEndpointForService(endpoint, port, serviceName) {
  if (typeof endpoint !== "string" || !endpoint) return false;
  const serviceRe = OWNER_ENDPOINT_SERVICE_RE[serviceName];
  const headlessRe = OWNER_ENDPOINT_HEADLESS_RE[serviceName];
  if (!serviceRe) throw new Error(`Unknown owner endpoint service ${serviceName}`);
  if (/[/?#@[\]\\]/.test(endpoint)) return false;
  let url;
  try {
    url = new URL(`http://${endpoint}`);
  } catch {
    return false;
  }
  if (url.host !== endpoint || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return false;
  }
  if (url.port !== String(port)) return false;
  // ECS task ENI addresses are VPC-local but not necessarily RFC1918; some
  // deployments may use non-RFC1918 VPC-local ranges. Trust comes from
  // runtime-authored owner-hint headers, while this check rejects URL injection
  // and obviously unsafe endpoint classes.
  return serviceRe.test(url.hostname) || headlessRe.test(url.hostname) || acceptableIpv4(url.hostname);
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function acceptableIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(/** @param {string} part */ (part) => {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some(/** @param {number | null} octet */ (octet) => octet === null)) return false;
  const [a, b] = octets;
  if (a == null || b == null) return false;
  if (a === 0 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a >= 224) return false;
  return true;
}
