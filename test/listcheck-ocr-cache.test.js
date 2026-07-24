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

test('extractNamesFromImage can refine dropped umlauts with a targeted candidate pass', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  let geminiCalls = 0;

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/ambiguous-diacritic-image.png') {
      return new Response(new Uint8Array([16, 17, 18]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      const m = requestedUrl.match(/payload=([^&]+)/);
      const decoded = m ? Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8') : '';
      const q = ((decoded.match(/,"([^"]*)","NA"\]/) || [])[1] || '').toLowerCase();
      if (q === 'cruelfighter') {
        const data = [
          [1, 5],
          [2, 3, 4],
          'Cr\u00fcelfighter',
          'infighter_male',
          1768.3334,
          [6, 7, 8],
          'Cruelfighter',
          'blade',
          1640,
        ];
        return Response.json({ type: 'result', result: JSON.stringify(data) });
      }
      if (q === 'qiylyn') {
        const data = [[1], [2, 3, 4], 'Qiylyn', 'weather_artist', 1753.3334];
        return Response.json({ type: 'result', result: JSON.stringify(data) });
      }
      return Response.json({ type: 'result', result: JSON.stringify([[]]) });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      const text = geminiCalls === 1
        ? JSON.stringify(['Cruelfighter', 'Qiylyn'])
        : JSON.stringify({ Cruelfighter: 'Cr\u00fcelfighter' });
      return Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text }] },
          },
        ],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'image-ambiguous-diacritic',
      url: 'https://cdn.discordapp.com/ambiguous-diacritic-image.png',
      contentType: 'image/png',
    }, { refineAmbiguousDiacritics: true });

    assert.deepEqual(names, ['Cr\u00fcelfighter', 'Qiylyn']);
    assert.equal(geminiCalls, 2);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});

test('extractNamesFromImage bounds and parallelizes ambiguous-name refinement', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  const originalMaxNames = config.listcheckMaxNames;
  const originalConcurrency = config.listcheckRosterLookupConcurrency;
  const names = Array.from({ length: 10 }, (_, index) => `Benchname${index}`);
  let searchCalls = 0;
  let activeSearches = 0;
  let maxActiveSearches = 0;

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['fake-model'];
  config.listcheckMaxNames = 8;
  config.listcheckRosterLookupConcurrency = 3;

  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/refine-concurrency.png') {
      return new Response(new Uint8Array([19, 20, 21]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      return Response.json({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify(names) }] },
        }],
      });
    }

    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      searchCalls += 1;
      activeSearches += 1;
      maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeSearches -= 1;

      const payload = new URL(requestedUrl).searchParams.get('payload');
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      const query = decoded[1];
      const table = [{ _: 1 }, [2], [3, 4, 5], query, 'blade', 1700];
      return Response.json({ type: 'result', data: JSON.stringify(table) });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const result = await extractNamesFromImage({
      id: 'refine-concurrency',
      url: 'https://cdn.discordapp.com/refine-concurrency.png',
      contentType: 'image/png',
    }, { refineAmbiguousDiacritics: true });

    assert.deepEqual(result, names, 'names beyond the check limit should remain available for ignored-count UI');
    assert.equal(searchCalls, 8, 'refinement should stop at the configured list-check limit');
    assert.ok(maxActiveSearches > 1, 'refinement searches should overlap');
    assert.ok(maxActiveSearches <= 3, 'refinement must respect configured concurrency');
  } finally {
    globalThis.fetch = originalFetch;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    config.listcheckMaxNames = originalMaxNames;
    config.listcheckRosterLookupConcurrency = originalConcurrency;
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
