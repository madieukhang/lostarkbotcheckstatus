/**
 * responseBody.js
 * Read a fetch response body under a byte ceiling, for downloads whose size
 * the sender controls.
 */

/**
 * Read a response body, refusing a declared Content-Length over the ceiling
 * and cancelling the stream once the bytes received pass it, so a body with
 * no length or a false one never lands whole in memory.
 * @param {Response} response fetch response with an unread body
 * @param {number} maxBytes largest body accepted
 * @returns {Promise<Buffer>} the body
 * @throws {RangeError} with code BODY_TOO_LARGE when the body passes maxBytes
 */
export async function readBodyWithin(response, maxBytes) {
  const tooLarge = () => Object.assign(
    new RangeError(`response body is larger than ${maxBytes} bytes`),
    { code: 'BODY_TOO_LARGE' },
  );
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw tooLarge();
  }
  const chunks = [];
  let received = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}
