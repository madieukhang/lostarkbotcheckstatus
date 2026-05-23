import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../bot/config.js';
import {
  clearOcrCache,
  extractNamesFromImage,
} from '../bot/services/list-check/service.js';

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

test('extractNamesFromImage dedupes canonical-equivalent diacritic spellings', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/diacritic-image.png') {
      return new Response(new Uint8Array([4, 5, 6]), {
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
              parts: [{ text: JSON.stringify(['zoë', 'zoe\u0308', 'zoe\u00A8']) }],
            },
          },
        ],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'image-diacritic',
      url: 'https://cdn.discordapp.com/diacritic-image.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['Zoë']);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});

test('extractNamesFromImage canonicalizes umlaut OCR split artifacts', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/umlaut-split-image.png') {
      return new Response(new Uint8Array([7, 8, 9]), {
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
              parts: [{
                text: JSON.stringify([
                  'b\u00E1nhcanhci\u00F9a',
                  'b\u00E1nhcanhc\u00FCa',
                ]),
              }],
            },
          },
        ],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'image-umlaut-split',
      url: 'https://cdn.discordapp.com/umlaut-split-image.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['B\u00E1nhcanhc\u00FCa']);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});

test('extractNamesFromImage removes OCR-inserted spaces inside names', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/spaced-name-image.png') {
      return new Response(new Uint8Array([10, 11, 12]), {
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
              parts: [{ text: JSON.stringify(['Gunlancer rrrrrrrr', 'Qy oir']) }],
            },
          },
        ],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'image-spaced-name',
      url: 'https://cdn.discordapp.com/spaced-name-image.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['Gunlancerrrrrrrrr', 'Qyoir']);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});

test('extractNamesFromImage repairs observed Banhcanhcua umlaut collapses', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/banhcanh-image.png') {
      return new Response(new Uint8Array([13, 14, 15]), {
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
              parts: [{ text: JSON.stringify(['B\u00E1nhcanhc\u00F9a', 'B\u00E1nhcanh\u00F9a']) }],
            },
          },
        ],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'image-banhcanh',
      url: 'https://cdn.discordapp.com/banhcanh-image.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['B\u00E1nhcanhc\u00FCa']);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});

test('extractNamesFromImage rejects oversized downloads even when content-length is missing', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  const requestedUrls = [];

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);

    if (requestedUrl === 'https://cdn.discordapp.com/oversized-image.png') {
      return new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      throw new Error('Gemini should not be called for oversized images');
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    await assert.rejects(
      () => extractNamesFromImage({
        id: 'image-oversized',
        url: 'https://cdn.discordapp.com/oversized-image.png',
        contentType: 'image/png',
      }),
      /Image file too large/
    );
    assert.equal(requestedUrls.length, 1);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});
