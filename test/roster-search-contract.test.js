import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SCRAPERAPI_KEY = '';
process.env.SCRAPERAPI_KEY_2 = '';
process.env.SCRAPERAPI_KEY_3 = '';

let fetchNameSuggestions;
let recoverViaPrefixIndel;
let recoverViaPrefixTransposition;

test.before(async () => {
  ({ fetchNameSuggestions } = await import('../bot/services/roster/search.js'));
  ({
    recoverViaPrefixIndel,
    recoverViaPrefixTransposition,
  } = await import('../bot/services/list-check/nameRecovery.js'));
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
