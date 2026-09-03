import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../bot/config.js';
import { fetchWithFallback } from '../bot/services/roster/bibleFetch.js';

test('caller deadline covers direct and ScraperAPI attempts and stops key rotation', async () => {
  const originalFetch = globalThis.fetch;
  const originalKeys = [...config.scraperApiKeys];
  const controller = new AbortController();
  const observedSignals = [];
  let scraperCalls = 0;

  config.scraperApiKeys.splice(
    0,
    config.scraperApiKeys.length,
    'fake-scraper-key-1',
    'fake-scraper-key-2',
  );
  globalThis.fetch = async (url, init = {}) => {
    const requestedUrl = String(url);
    observedSignals.push(init.signal);
    if (!requestedUrl.startsWith('https://api.scraperapi.com/')) {
      return new Response('blocked', { status: 503 });
    }

    scraperCalls += 1;
    setTimeout(() => controller.abort(new DOMException('phase timeout', 'TimeoutError')), 10);
    return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };

  try {
    const response = await fetchWithFallback('https://lostark.bible/test-deadline', {
      signal: controller.signal,
    });

    assert.equal(response.status, 503, 'the original direct response remains the safe fallback');
    assert.equal(scraperCalls, 1, 'an expired caller deadline must not rotate into another key');
    assert.deepEqual(observedSignals, [controller.signal, controller.signal]);
  } finally {
    config.scraperApiKeys.splice(0, config.scraperApiKeys.length, ...originalKeys);
    globalThis.fetch = originalFetch;
  }
});
