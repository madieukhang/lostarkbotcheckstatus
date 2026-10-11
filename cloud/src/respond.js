/**
 * cloud/src/respond.js
 * JSON envelope shared with the lostark-web gateway: { ok: true, data } on success,
 * { ok: false, error: { code } } on failure.
 */

/**
 * @param {unknown} data Response payload.
 * @param {number} [status=200] HTTP status.
 * @returns {Response} JSON success response.
 */
export function ok(data, status = 200) {
  return Response.json({ ok: true, data }, { status });
}

/**
 * @param {number} status HTTP status.
 * @param {string} code Machine-readable error code the web UI translates.
 * @returns {Response} JSON failure response.
 */
export function fail(status, code) {
  return Response.json({ ok: false, error: { code } }, { status });
}
