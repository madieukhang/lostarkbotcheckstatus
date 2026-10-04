/**
 * Parse an HTTP `Retry-After` header value into a delay in milliseconds.
 *
 * Accepts both RFC 9110 forms — delay-seconds (`"120"`) and HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`) — and returns `fallbackMs` when the
 * value is missing or unparseable. An optional `capMs` bounds the parsed
 * delay so a far-future server date cannot stall the caller.
 *
 * @param {string|null|undefined} value - raw header value
 * @param {object} [options]
 * @param {number} [options.fallbackMs=0] - returned when the value is missing
 *   or cannot be parsed
 * @param {number} [options.capMs] - optional upper bound on the parsed delay
 * @param {() => number} [options.now=Date.now] - clock used for HTTP-date values
 * @returns {number} delay in milliseconds
 */
export function parseRetryAfterMs(value, { fallbackMs = 0, capMs, now = Date.now } = {}) {
  const cap = (ms) => (capMs === undefined ? ms : Math.min(ms, capMs));

  const text = String(value || '').trim();
  if (!text) return fallbackMs;

  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return cap(Math.ceil(seconds * 1000));
  }

  const retryAt = Date.parse(text);
  return Number.isFinite(retryAt) ? cap(Math.max(0, retryAt - now())) : fallbackMs;
}
