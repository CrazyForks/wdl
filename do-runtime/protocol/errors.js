import { sanitizeJsonErrorDetails } from "shared-respond";

export class DoRuntimeError extends Error {
  /** @type {unknown} */
  details;

  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "DoRuntimeError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * @param {unknown} err
 * @returns {Response}
 */
export function doErrorResponse(err) {
  if (err instanceof DoRuntimeError) {
    const details = sanitizeJsonErrorDetails(err.details);
    return Response.json({
      error: err.code,
      message: err.message,
      ...(details === undefined ? {} : { details }),
    }, { status: err.status });
  }
  return Response.json({
    error: "internal_error",
    message: "Internal error",
  }, { status: 500 });
}
