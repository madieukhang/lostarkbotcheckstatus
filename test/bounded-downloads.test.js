import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../bot/config.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { rehostImage } from '../bot/utils/imageRehost.js';
import { readBodyWithin } from '../bot/utils/responseBody.js';
import { getMultiServerStatus } from '../bot/monitor/serverStatus.js';
import { extractNamesFromImage, clearOcrCache, clearGeminiModelCooldowns } from '../bot/services/list-check/ocr.js';

const MIB = 1024 * 1024;

// A 64 MiB image body sent 1 MiB at a time with no Content-Length, counting
// how many chunks the reader pulls.
function streamedBody(pulls) {
  const chunk = new Uint8Array(MIB);
  return new Response(new ReadableStream({
    pull(controller) {
      pulls.count += 1;
      if (pulls.count > 64) controller.close();
      else controller.enqueue(chunk);
    },
  }), { headers: { 'content-type': 'image/png' } });
}

test('a declared Content-Length over the ceiling is refused before the body is read', async () => {
  const pulls = { count: 0 };
  const response = new Response(streamedBody(pulls).body, { headers: { 'content-length': String(64 * MIB) } });

  await assert.rejects(readBodyWithin(response, 20 * MIB), { code: 'BODY_TOO_LARGE' });
  assert.ok(pulls.count <= 1, `pulled ${pulls.count} MiB`);
});

test('rehost stops reading an oversized body at its 24 MiB ceiling and sets a download deadline', async t => {
  const ownerGuildId = config.ownerGuildId;
  config.ownerGuildId = 'bounded-download-owner';
  t.after(() => { config.ownerGuildId = ownerGuildId; invalidateGuildConfig('bounded-download-owner'); });
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ evidenceChannelId: 'evidence' }) }));
  t.mock.method(console, 'warn', () => {});
  const pulls = { count: 0 };
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options?.signal;
    return streamedBody(pulls);
  });

  await assert.rejects(
    rehostImage('https://example.test/huge.png', {}, { throwOnError: true }),
    /too large to rehost/,
  );
  assert.ok(pulls.count <= 26, `pulled ${pulls.count} MiB`);
  assert.ok(signal instanceof AbortSignal);
});

test('the server status monitor stops reading an oversized status page', async t => {
  const pulls = { count: 0 };
  t.mock.method(globalThis, 'fetch', async () => streamedBody(pulls));

  await assert.rejects(getMultiServerStatus(['Thaemine']), /larger than/);
  assert.ok(pulls.count <= 4, `pulled ${pulls.count} MiB`);
});

test('OCR stops reading a body without Content-Length before base64 would exceed Gemini inline limit', async t => {
  clearOcrCache();
  clearGeminiModelCooldowns();
  const key = config.geminiApiKey;
  config.geminiApiKey = 'offline-test-key';
  t.after(() => { config.geminiApiKey = key; clearOcrCache(); clearGeminiModelCooldowns(); });
  const pulls = { count: 0 };
  t.mock.method(globalThis, 'fetch', async () => streamedBody(pulls));

  await assert.rejects(
    extractNamesFromImage({ url: 'https://cdn.discordapp.com/huge.png', contentType: 'image/png' }),
    /Image file too large/,
  );
  assert.ok(pulls.count <= 16, `pulled ${pulls.count} MiB`);
});
