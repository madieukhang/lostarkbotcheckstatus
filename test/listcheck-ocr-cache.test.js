import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../bot/config.js';
import {
  extractNamesFromImage,
} from '../bot/services/list-check/service.js';
import {
  clearGeminiModelCooldowns,
  clearOcrCache,
} from '../bot/services/list-check/ocr.js';
import { clearNameSuggestionCache } from '../bot/services/roster/search.js';

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

test('extractNamesFromImage drops invalid and out-of-range OCR tokens', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/invalid-name-image.png') {
      return new Response(new Uint8Array([31, 32, 33]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      return Response.json({
        candidates: [{
          finishReason: 'STOP',
          content: {
            parts: [{
              text: JSON.stringify([
                'Validname',
                'Name2',
                'A',
                '9start',
                'Bad-name',
                'ABCDEFGHIJKLMNOPQRSTU',
              ]),
            }],
          },
        }],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'image-invalid-names',
      url: 'https://cdn.discordapp.com/invalid-name-image.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['Validname', 'Name2']);
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
        ? JSON.stringify(['Cruelfighter', 'Cr\u00fcelfighter', 'Qiylyn'])
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

    assert.deepEqual(
      names,
      ['Cr\u00fcelfighter', 'Qiylyn'],
      'refinement must collapse OCR rows that converge on one canonical character',
    );
    assert.equal(geminiCalls, 2);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});

test('extractNamesFromImage rechecks a wrong accent even when it exactly names another character', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  let geminiCalls = 0;

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl === 'https://cdn.discordapp.com/wrong-accent-image.png') {
      return new Response(new Uint8Array([20, 21, 22]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      const data = [
        [1, 5],
        [2, 3, 4],
        'Crüelfighter',
        'infighter_male',
        1768.3334,
        [6, 7, 8],
        'Crúelfighter',
        'blade',
        1640,
      ];
      return Response.json({ type: 'result', result: JSON.stringify(data) });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      const text = geminiCalls === 1
        ? JSON.stringify(['Crúelfighter'])
        : JSON.stringify({ 'Crúelfighter': 'Crüelfighter' });
      return Response.json({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text }] },
        }],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'wrong-accent-image',
      url: 'https://cdn.discordapp.com/wrong-accent-image.png',
      contentType: 'image/png',
    }, { refineAmbiguousDiacritics: true });

    assert.deepEqual(names, ['Crüelfighter']);
    assert.equal(geminiCalls, 2, 'ambiguous marked spelling should trigger one targeted image pass');
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
  const originalLookupTimeoutMs = config.listcheckRosterLookupTimeoutMs;
  const names = Array.from({ length: 10 }, (_, index) => `Benchname${index}`);
  let searchCalls = 0;
  let activeSearches = 0;
  let maxActiveSearches = 0;
  const searchSignals = [];

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['fake-model'];
  config.listcheckMaxNames = 8;
  config.listcheckRosterLookupConcurrency = 3;
  config.listcheckRosterLookupTimeoutMs = 500;

  globalThis.fetch = async (url, init = {}) => {
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
      searchSignals.push(init.signal);
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
    assert.ok(searchSignals.every((signal) => signal === searchSignals[0]));
    assert.equal(searchSignals[0]?.aborted, false, 'all searches should share one live phase deadline');
  } finally {
    globalThis.fetch = originalFetch;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    config.listcheckMaxNames = originalMaxNames;
    config.listcheckRosterLookupConcurrency = originalConcurrency;
    config.listcheckRosterLookupTimeoutMs = originalLookupTimeoutMs;
    clearOcrCache();
  }
});

test('ambiguous-name refinement stops scheduling queued searches after its shared deadline', async () => {
  clearOcrCache();
  clearNameSuggestionCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  const originalMaxNames = config.listcheckMaxNames;
  const originalConcurrency = config.listcheckRosterLookupConcurrency;
  const originalLookupTimeoutMs = config.listcheckRosterLookupTimeoutMs;
  const names = Array.from({ length: 8 }, (_, index) => `Timeoutname${index}`);
  let searchCalls = 0;

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['fake-model'];
  config.listcheckMaxNames = 8;
  config.listcheckRosterLookupConcurrency = 3;
  config.listcheckRosterLookupTimeoutMs = 20;

  globalThis.fetch = async (url, init = {}) => {
    const requestedUrl = String(url);
    if (requestedUrl === 'https://cdn.discordapp.com/refine-deadline.png') {
      return new Response(new Uint8Array([28, 29, 30]), {
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
      return new Promise((_resolve, reject) => {
        // A real fetch socket keeps Node alive while AbortSignal.timeout uses
        // an unref'ed timer. This short guard gives the mock the same lifetime.
        const networkGuard = setTimeout(
          () => reject(new Error('mock network guard expired')),
          1000,
        );
        const rejectOnAbort = () => {
          clearTimeout(networkGuard);
          reject(init.signal?.reason || new DOMException('phase timeout', 'TimeoutError'));
        };
        if (init.signal?.aborted) rejectOnAbort();
        else init.signal?.addEventListener('abort', rejectOnAbort, { once: true });
      });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const result = await extractNamesFromImage({
      id: 'refine-deadline',
      url: 'https://cdn.discordapp.com/refine-deadline.png',
      contentType: 'image/png',
    }, { refineAmbiguousDiacritics: true });

    assert.deepEqual(result, names, 'deadline fallback must keep the original OCR names');
    assert.equal(searchCalls, 3, 'only the first concurrency batch should reach the network');
  } finally {
    globalThis.fetch = originalFetch;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    config.listcheckMaxNames = originalMaxNames;
    config.listcheckRosterLookupConcurrency = originalConcurrency;
    config.listcheckRosterLookupTimeoutMs = originalLookupTimeoutMs;
    clearOcrCache();
    clearNameSuggestionCache();
  }
});

test('extractNamesFromImage uses a Gemini 3-safe request while failing over recoverable errors', async () => {
  clearOcrCache();
  clearGeminiModelCooldowns();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  const requestedModels = [];
  const generationConfigs = [];
  const requestSignals = [];

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = [
    'rate-limited-model',
    'server-error-model',
    'non-json-model',
    'working-model',
  ];
  globalThis.fetch = async (url, init = {}) => {
    const requestedUrl = String(url);
    if (requestedUrl === 'https://cdn.discordapp.com/model-failover.png') {
      return new Response(new Uint8Array([22, 23, 24]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      const model = decodeURIComponent(requestedUrl.match(/models\/([^:]+):/)?.[1] || '');
      requestedModels.push(model);
      generationConfigs.push(JSON.parse(init.body).generationConfig);
      requestSignals.push(init.signal);
      if (model === 'rate-limited-model') {
        return new Response('RESOURCE_EXHAUSTED', { status: 429 });
      }
      if (model === 'server-error-model') {
        return new Response('TEMPORARY_UPSTREAM_FAILURE', { status: 502 });
      }
      if (model === 'non-json-model') {
        return Response.json({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }],
        });
      }
      return Response.json({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '["Fallbackname"]' }] } }],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'model-failover',
      url: 'https://cdn.discordapp.com/model-failover.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['Fallbackname']);
    assert.deepEqual(requestedModels, config.geminiModels);
    assert.deepEqual(
      generationConfigs,
      config.geminiModels.map(() => ({
        maxOutputTokens: 768,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'low' },
      })),
    );
    assert.ok(requestSignals.every((signal) => signal?.aborted === false));
    assert.equal(
      new Set(requestSignals).size,
      requestSignals.length,
      'each quick recoverable failure should preserve a fresh soft deadline for the next model',
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    clearGeminiModelCooldowns();
    clearOcrCache();
  }
});

test('extractNamesFromImage abandons a slow primary without exhausting the shared deadline', async () => {
  clearOcrCache();
  clearGeminiModelCooldowns();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  const originalPrimaryTimeoutMs = config.geminiPrimaryTimeoutMs;
  const originalPrimaryTimeoutOverridden = config.geminiPrimaryTimeoutOverridden;
  const requestedModels = [];
  const requestSignals = [];
  const logs = [];
  const warnings = [];

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['slow-primary-model', 'working-fallback-model'];
  config.geminiPrimaryTimeoutMs = 20;
  config.geminiPrimaryTimeoutOverridden = true;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));
  globalThis.fetch = async (url, init = {}) => {
    const requestedUrl = String(url);
    if (requestedUrl === 'https://cdn.discordapp.com/slow-primary.png') {
      return new Response(new Uint8Array([34, 35, 36]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      const model = decodeURIComponent(requestedUrl.match(/models\/([^:]+):/)?.[1] || '');
      requestedModels.push(model);
      requestSignals.push(init.signal);
      if (model === 'slow-primary-model') {
        return new Promise((_resolve, reject) => {
          const networkGuard = setTimeout(
            () => reject(new Error('mock network guard expired')),
            1000,
          );
          const rejectOnAbort = () => {
            clearTimeout(networkGuard);
            reject(init.signal?.reason || new DOMException('phase timeout', 'TimeoutError'));
          };
          if (init.signal?.aborted) rejectOnAbort();
          else init.signal?.addEventListener('abort', rejectOnAbort, { once: true });
        });
      }
      return Response.json({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '["Fastfallback"]' }] },
        }],
        usageMetadata: {
          promptTokenCount: 300,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 40,
          totalTokenCount: 348,
        },
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'slow-primary',
      url: 'https://cdn.discordapp.com/slow-primary.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['Fastfallback']);
    assert.deepEqual(requestedModels, config.geminiModels);
    assert.equal(requestSignals[0]?.aborted, true, 'primary soft deadline should abort only its request');
    assert.equal(requestSignals[1]?.aborted, false, 'fallback should retain the shared deadline');
    assert.ok(
      logs.some((message) => (
        /modelTimings=slow-primary-model:\d+ms,working-fallback-model:\d+ms/.test(message)
      )),
      'OCR timing should preserve each model attempt instead of only the aggregate',
    );
    assert.ok(
      warnings.some((message) => (
        message.includes('slow-primary-model exceeded 20ms')
        && message.includes('trying fallback model')
      )),
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    config.geminiPrimaryTimeoutMs = originalPrimaryTimeoutMs;
    config.geminiPrimaryTimeoutOverridden = originalPrimaryTimeoutOverridden;
    clearGeminiModelCooldowns();
    clearOcrCache();
  }
});

test('extractNamesFromImage skips a recoverably failed model until its cooldown expires', async () => {
  clearOcrCache();
  clearGeminiModelCooldowns();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  const originalCooldownMs = config.geminiModelCooldownMs;
  const requestedModels = [];
  const warnings = [];
  let busyCalls = 0;
  let now = 1_000_000;

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['busy-model', 'healthy-model'];
  config.geminiModelCooldownMs = 25;
  Date.now = () => now;
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.startsWith('https://cdn.discordapp.com/cooldown-')) {
      return new Response(new Uint8Array([40, 41, 42]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      const model = decodeURIComponent(requestedUrl.match(/models\/([^:]+):/)?.[1] || '');
      requestedModels.push(model);
      if (model === 'busy-model') {
        busyCalls += 1;
        if (busyCalls === 1) return new Response('high demand', { status: 503 });
        return Response.json({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '["Recovered"]' }] } }],
        });
      }
      return Response.json({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '["Healthy"]' }] } }],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const first = await extractNamesFromImage({
      id: 'cooldown-first',
      url: 'https://cdn.discordapp.com/cooldown-first.png',
      contentType: 'image/png',
    });
    const second = await extractNamesFromImage({
      id: 'cooldown-second',
      url: 'https://cdn.discordapp.com/cooldown-second.png',
      contentType: 'image/png',
    });

    assert.deepEqual(first, ['Healthy']);
    assert.deepEqual(second, ['Healthy']);
    assert.deepEqual(requestedModels, ['busy-model', 'healthy-model', 'healthy-model']);
    assert.ok(warnings.some((message) => (
      message.includes('busy-model cooling down after HTTP 503')
      && message.includes('skipping')
    )));

    now += 26;
    const third = await extractNamesFromImage({
      id: 'cooldown-third',
      url: 'https://cdn.discordapp.com/cooldown-third.png',
      contentType: 'image/png',
    });

    assert.deepEqual(third, ['Recovered']);
    assert.deepEqual(requestedModels, [
      'busy-model',
      'healthy-model',
      'healthy-model',
      'busy-model',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    console.warn = originalWarn;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    config.geminiModelCooldownMs = originalCooldownMs;
    clearGeminiModelCooldowns();
    clearOcrCache();
  }
});

test('extractNamesFromImage fails fast when every configured model is cooling down', async () => {
  clearOcrCache();
  clearGeminiModelCooldowns();
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  const originalCooldownMs = config.geminiModelCooldownMs;
  let geminiCalls = 0;

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['busy-a-model', 'busy-b-model'];
  config.geminiModelCooldownMs = 1_000;
  console.warn = () => {};
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.startsWith('https://cdn.discordapp.com/all-cooling-')) {
      return new Response(new Uint8Array([43, 44, 45]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return new Response('high demand', { status: 503 });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const firstError = await extractNamesFromImage({
        id: 'all-cooling-first',
        url: 'https://cdn.discordapp.com/all-cooling-first.png',
        contentType: 'image/png',
      }).then(() => null, (error) => error);
    assert.match(firstError?.message || '', /HTTP 503/);
    assert.equal(firstError?.code, 'GEMINI_MODELS_COOLING_DOWN');
    assert.ok(firstError?.retryAfterMs > 0);

    const secondError = await extractNamesFromImage({
        id: 'all-cooling-second',
        url: 'https://cdn.discordapp.com/all-cooling-second.png',
        contentType: 'image/png',
      }).then(() => null, (error) => error);
    assert.match(secondError?.message || '', /temporarily cooling down/);
    assert.equal(secondError?.code, 'GEMINI_MODELS_COOLING_DOWN');
    assert.ok(secondError?.retryAfterMs > 0);
    assert.equal(geminiCalls, 2, 'the second request must not hammer cooled-down models');
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    config.geminiModelCooldownMs = originalCooldownMs;
    clearGeminiModelCooldowns();
    clearOcrCache();
  }
});

test('extractNamesFromImage rejects a MAX_TOKENS prefix even when it is valid JSON', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  const requestedModels = [];
  const warnings = [];

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['truncated-model', 'working-model'];
  console.warn = (...args) => warnings.push(args.join(' '));
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl === 'https://cdn.discordapp.com/max-tokens.png') {
      return new Response(new Uint8Array([31, 32, 33]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      const model = decodeURIComponent(requestedUrl.match(/models\/([^:]+):/)?.[1] || '');
      requestedModels.push(model);
      if (model === 'truncated-model') {
        return Response.json({
          candidates: [{
            finishReason: 'MAX_TOKENS',
            content: { parts: [{ text: '["Linhieee"]' }] },
          }],
          usageMetadata: {
            promptTokenCount: 220,
            candidatesTokenCount: 18,
            thoughtsTokenCount: 1006,
            totalTokenCount: 1244,
          },
        });
      }
      return Response.json({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '["Linhieee","Prèf"]' }] },
        }],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const names = await extractNamesFromImage({
      id: 'max-tokens',
      url: 'https://cdn.discordapp.com/max-tokens.png',
      contentType: 'image/png',
    });

    assert.deepEqual(names, ['Linhieee', 'Prèf']);
    assert.deepEqual(requestedModels, config.geminiModels);
    assert.ok(
      warnings.some((message) => (
        message.includes('finishReason: MAX_TOKENS')
        && message.includes('thoughts=1006')
      )),
      'MAX_TOKENS diagnostics should include available thought-token usage',
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
    clearOcrCache();
  }
});

test('extractNamesFromImage keeps invalid JSON terminal instead of trying another model', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  const originalModels = [...config.geminiModels];
  let geminiCalls = 0;

  config.geminiApiKey = 'fake-gemini-key';
  config.geminiModels = ['invalid-json-model', 'unused-fallback-model'];
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl === 'https://cdn.discordapp.com/invalid-json.png') {
      return new Response(new Uint8Array([25, 26, 27]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return Response.json({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '["Broken",]' }] } }],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    await assert.rejects(
      () => extractNamesFromImage({
        id: 'invalid-json',
        url: 'https://cdn.discordapp.com/invalid-json.png',
        contentType: 'image/png',
      }),
      /Gemini returned invalid JSON/,
    );
    assert.equal(geminiCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    config.geminiApiKey = originalKey;
    config.geminiModels = originalModels;
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

test('extractNamesFromImage rejects inline payloads that exceed Gemini limit after encoding', async () => {
  clearOcrCache();
  const originalFetch = globalThis.fetch;
  const originalKey = config.geminiApiKey;
  const requestedUrls = [];

  config.geminiApiKey = 'fake-gemini-key';
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);

    if (requestedUrl === 'https://cdn.discordapp.com/base64-overhead.png') {
      // 15 MiB becomes 20 MiB as base64 before JSON and prompt overhead.
      return new Response(new Uint8Array(15 * 1024 * 1024), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    throw new Error('Gemini should not receive an oversized inline request');
  };

  try {
    await assert.rejects(
      () => extractNamesFromImage({
        id: 'base64-overhead',
        url: 'https://cdn.discordapp.com/base64-overhead.png',
        contentType: 'image/png',
      }),
      /inline request too large/,
    );
    assert.equal(requestedUrls.length, 1);
  } finally {
    config.geminiApiKey = originalKey;
    globalThis.fetch = originalFetch;
    clearOcrCache();
  }
});
