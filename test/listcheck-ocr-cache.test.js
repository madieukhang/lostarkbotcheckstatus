import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../bot/config.js';
import {
  clearOcrCache,
  extractNamesFromImage,
} from '../bot/services/listCheckService.js';

test('extractNamesFromImage caches OCR results for repeated attachment URLs', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  const requestedUrls = [];

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);

    if (requestedUrl === 'https://cdn.discordapp.com/test-image.png') {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      return Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [{ text: '["alice","bob","alice"]' }],
            },
          },
        ],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const image = {
      id: 'image-1',
      url: 'https://cdn.discordapp.com/test-image.png',
      contentType: 'image/png',
    };

    const first = await extractNamesFromImage(image);
    const second = await extractNamesFromImage(image);

    assert.deepEqual(first, ['Alice', 'Bob']);
    assert.deepEqual(second, ['Alice', 'Bob']);
    assert.equal(requestedUrls.length, 2);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});
