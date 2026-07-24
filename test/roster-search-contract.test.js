import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SCRAPERAPI_KEY = '';
process.env.SCRAPERAPI_KEY_2 = '';
process.env.SCRAPERAPI_KEY_3 = '';

let fetchNameSuggestions;
let clearNameSuggestionCache;
let createNameSuggestionContext;
let config;
let recoverViaPrefixIndel;
let recoverViaPrefixTransposition;
let recoverViaVisualSubstitution;

test.before(async () => {
  ({
    clearNameSuggestionCache,
    createNameSuggestionContext,
    fetchNameSuggestions,
  } = await import('../bot/services/roster/search.js'));
  ({ default: config } = await import('../bot/config.js'));
  ({
    recoverViaPrefixIndel,
    recoverViaPrefixTransposition,
    recoverViaVisualSubstitution,
  } = await import('../bot/services/list-check/nameRecovery.js'));
});

test.beforeEach(() => {
  clearNameSuggestionCache();
});

async function withSearchResponse(responseBody, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(responseBody);
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('fetchNameSuggestions decodes the current data envelope', async () => {
  const table = [
    { _: 1, q: 6 },
    [2],
    [3, 4, 5],
    'Ainslinn',
    'bard',
    1726.6666,
    { cache: 7 },
    { v: 1 },
  ];

  const suggestions = await withSearchResponse(
    { type: 'result', data: JSON.stringify(table) },
    () => fetchNameSuggestions('Ainslinn', { allowScraperApi: false }),
  );

  assert.deepEqual(suggestions, [{
    name: 'Ainslinn',
    cls: 'bard',
    itemLevel: 1726.6666,
  }]);
});

test('fetchNameSuggestions keeps decoding the legacy result envelope', async () => {
  const table = [[1], [2, 3, 4], 'Ainslinn', 'bard', 1726.6666];

  const suggestions = await withSearchResponse(
    { type: 'result', result: JSON.stringify(table) },
    () => fetchNameSuggestions('Ainslinn', { allowScraperApi: false }),
  );

  assert.deepEqual(suggestions, [{
    name: 'Ainslinn',
    cls: 'bard',
    itemLevel: 1726.6666,
  }]);
});

test('fetchNameSuggestions decodes an empty current envelope as no matches', async () => {
  const table = [{ _: 1, q: 2 }, [], { cache: 3 }, { v: 1 }];

  const suggestions = await withSearchResponse(
    { type: 'result', data: JSON.stringify(table) },
    () => fetchNameSuggestions('MissingName', { allowScraperApi: false }),
  );

  assert.deepEqual(suggestions, []);
});

test('fetchNameSuggestions deduplicates concurrent lookups in one request cache', async () => {
  const originalFetch = globalThis.fetch;
  const suggestionCache = new Map();
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const table = [{ _: 1 }, [2], [3, 4, 5], 'Ainslinn', 'bard', 1726.6666];
    return Response.json({ type: 'result', data: JSON.stringify(table) });
  };

  try {
    const [first, second] = await Promise.all([
      fetchNameSuggestions('Ainslinn', { suggestionCache }),
      fetchNameSuggestions('ainslinn', { suggestionCache }),
    ]);

    assert.equal(fetchCalls, 1);
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchNameSuggestions reuses successful lookups across request-local caches', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    const table = [{ _: 1 }, [2], [3, 4, 5], 'Sharedname', 'bard', 1710];
    return Response.json({ type: 'result', data: JSON.stringify(table) });
  };

  try {
    const first = await fetchNameSuggestions('Sharedname', {
      allowScraperApi: false,
      suggestionCache: new Map(),
    });
    const second = await fetchNameSuggestions('sharedname', {
      allowScraperApi: false,
      suggestionCache: new Map(),
    });

    assert.equal(fetchCalls, 1);
    assert.deepEqual(second, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchNameSuggestions does not share-cache transport failures', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Response('', { status: 503 });
    const table = [{ _: 1 }, [2], [3, 4, 5], 'Recoveredname', 'bard', 1710];
    return Response.json({ type: 'result', data: JSON.stringify(table) });
  };

  try {
    const first = await fetchNameSuggestions('Recoveredname', {
      allowScraperApi: false,
      suggestionCache: new Map(),
    });
    const second = await fetchNameSuggestions('Recoveredname', {
      allowScraperApi: false,
      suggestionCache: new Map(),
    });

    assert.equal(first, null);
    assert.equal(second?.[0]?.name, 'Recoveredname');
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchNameSuggestions stops new network calls when the request budget is exhausted', async () => {
  const originalFetch = globalThis.fetch;
  const suggestionContext = createNameSuggestionContext({ maxNetworkLookups: 2 });
  let fetchCalls = 0;

  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    const payload = new URL(String(url)).searchParams.get('payload');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const query = decoded[1];
    const table = [{ _: 1 }, [2], [3, 4, 5], query, 'bard', 1710];
    return Response.json({ type: 'result', data: JSON.stringify(table) });
  };

  try {
    assert.ok(await fetchNameSuggestions('Budgetone', { suggestionContext }));
    assert.ok(await fetchNameSuggestions('Budgettwo', { suggestionContext }));
    assert.equal(
      await fetchNameSuggestions('Budgetthree', { suggestionContext }),
      null,
    );

    assert.equal(fetchCalls, 2);
    assert.equal(suggestionContext.stats.networkLookups, 2);
    assert.equal(suggestionContext.stats.budgetExhaustions, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prefix recovery reuses the same prefix searches across recovery strategies', async () => {
  const originalFetch = globalThis.fetch;
  const suggestionCache = new Map();
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({
      type: 'result',
      data: JSON.stringify([{ _: 1 }, []]),
    });
  };

  try {
    await recoverViaPrefixTransposition('Nonexistentzz', { suggestionCache });
    await recoverViaPrefixIndel('Nonexistentzz', { suggestionCache });

    assert.equal(fetchCalls, 7, '10-to-4 character prefixes should be fetched once, not twice');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('visual-substitution recovery caps candidate fan-out', async () => {
  const originalFetch = globalThis.fetch;
  const originalLimit = config.listcheckSimilarLookupLimit;
  let fetchCalls = 0;

  config.listcheckSimilarLookupLimit = 2;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({
      type: 'result',
      data: JSON.stringify([{ _: 1 }, []]),
    });
  };

  try {
    await recoverViaVisualSubstitution('Aqqqqq', {
      allowScraperApi: false,
      suggestionCache: new Map(),
    });

    assert.equal(fetchCalls, 2);
  } finally {
    config.listcheckSimilarLookupLimit = originalLimit;
    globalThis.fetch = originalFetch;
  }
});
