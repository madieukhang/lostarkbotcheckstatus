import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRosterCharacters,
  clearGuildMembersCache,
  detectAltsViaStronghold,
  extractCharacterItemLevelFromHtml,
  fetchCharacterMeta,
  fetchGuildMembers,
  fetchWithFallback,
} from '../bot/services/rosterService.js';
import config from '../bot/config.js';
import { clearMetaCache } from '../bot/utils/metaCache.js';

test('buildRosterCharacters encodes character names in roster URLs', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';

  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response('', { status: 404 });
  };

  try {
    await buildRosterCharacters('Name With/Slash#Hash');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestedUrl,
    'https://lostark.bible/character/NA/Name%20With%2FSlash%23Hash/roster'
  );
});

test('buildRosterCharacters can accept hidden rosters when profile meta exists', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  // Post-Phase-1 (commit 2908724) fetchCharacterMeta probes
  // `/__data.json` first and falls back to HTML on parse failure. The
  // mock here returns non-JSON content for the data.json probe so the
  // fallback path runs, exercising both legs in a single test.
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);

    if (requestedUrl.endsWith('/roster')) {
      return new Response('<html><body><h1>Hidden roster</h1></body></html>', { status: 200 });
    }

    if (requestedUrl.endsWith('/__data.json')) {
      // Force a JSON parse failure so the HTML fallback runs.
      return new Response('not-json', { status: 200 });
    }

    return new Response(
      'class:"bard",itemLevel:1723.33,rosterLevel:300,stronghold:{level:70,name:"AinsHome"},guild:{name:"AinsGuild",grade:"Member"}',
      { status: 200 }
    );
  };

  try {
    const result = await buildRosterCharacters('Ainslinn', {
      hiddenRosterFallback: true,
    });

    assert.equal(result.hasValidRoster, true);
    assert.deepEqual(result.allCharacters, ['Ainslinn']);
    assert.equal(result.targetItemLevel, 1723.33);
    assert.equal(result.rosterVisibility, 'hidden');
    assert.equal(requestedUrls[0], 'https://lostark.bible/character/NA/Ainslinn/roster');
    assert.equal(requestedUrls[1], 'https://lostark.bible/character/NA/Ainslinn/__data.json');
    assert.equal(requestedUrls[2], 'https://lostark.bible/character/NA/Ainslinn');
    assert.equal(requestedUrls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildRosterCharacters keeps hidden roster fallback opt-in', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return new Response('<html><body><h1>Hidden roster</h1></body></html>', { status: 200 });
  };

  try {
    const result = await buildRosterCharacters('Ainslinn');

    assert.equal(result.hasValidRoster, false);
    assert.deepEqual(result.allCharacters, ['Ainslinn']);
    assert.equal(result.rosterVisibility, 'missing');
    assert.deepEqual(requestedUrls, ['https://lostark.bible/character/NA/Ainslinn/roster']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCharacterMeta caches successful profile meta by character name', async () => {
  clearMetaCache();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({
      nodes: [
        {
          data: [
            { header: 1 },
            { rosterLevel: 2, stronghold: 3, guild: 6, class: 9, ilvl: 10 },
            300,
            { level: 4, name: 5 },
            70,
            'CacheHome',
            { name: 7, grade: 8 },
            'CacheGuild',
            'Member',
            'bard',
            1725.55,
          ],
        },
      ],
    });
  };

  try {
    const first = await fetchCharacterMeta('CacheName');
    const second = await fetchCharacterMeta('cachename');

    assert.equal(fetchCalls, 1);
    assert.deepEqual(second, first);
    assert.equal(first.rosterLevel, 300);
    assert.equal(first.itemLevel, 1725.55);
  } finally {
    globalThis.fetch = originalFetch;
    clearMetaCache();
  }
});

test('fetchCharacterMeta retries transient profile failures with fresh timeout signals', async () => {
  clearMetaCache();
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const signals = [];
  let fetchCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    fetchCalls += 1;
    requestedUrls.push(String(url));
    signals.push(options.signal);

    if (fetchCalls === 1) {
      return new Response('busy', { status: 503 });
    }

    return Response.json({
      nodes: [
        {
          data: [
            { header: 1 },
            { rosterLevel: 2, stronghold: 3, guild: 6, class: 9, ilvl: 10 },
            300,
            { level: 4, name: 5 },
            70,
            'RetryHome',
            { name: 7, grade: 8 },
            'RetryGuild',
            'Member',
            'bard',
            1725.55,
          ],
        },
      ],
    });
  };

  try {
    const result = await fetchCharacterMeta('RetryName', {
      useCache: false,
      allowScraperApi: false,
      retryOnRateLimit: true,
      timeoutMs: 8000,
      rateLimitRetryDelayMs: 1,
    });

    assert.equal(fetchCalls, 2);
    assert.deepEqual(requestedUrls, [
      'https://lostark.bible/character/NA/RetryName/__data.json',
      'https://lostark.bible/character/NA/RetryName/__data.json',
    ]);
    assert.ok(signals[0]);
    assert.ok(signals[1]);
    assert.notStrictEqual(signals[0], signals[1]);
    assert.equal(result.strongholdName, 'RetryHome');
  } finally {
    globalThis.fetch = originalFetch;
    clearMetaCache();
  }
});

test('detectAltsViaStronghold reuses provided meta and guild members without target lookups', async () => {
  clearMetaCache();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected fetch');
  };

  try {
    const result = await detectAltsViaStronghold('Ainslinn', {
      targetMeta: {
        rosterLevel: 300,
        strongholdLevel: 70,
        strongholdName: 'AinsHome',
        guildName: 'AinsGuild',
        guildGrade: 'Member',
        classId: 'bard',
        itemLevel: 1723.33,
      },
      guildMembers: [],
    });

    assert.equal(result, null);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearMetaCache();
  }
});

test('extractCharacterItemLevelFromHtml supports common SSR item level shapes', () => {
  assert.equal(extractCharacterItemLevelFromHtml('itemLevel:1723.33'), 1723.33);
  assert.equal(extractCharacterItemLevelFromHtml('"itemLevel":"1,723.33"'), 1723.33);
  assert.equal(extractCharacterItemLevelFromHtml('no item level here'), null);
});

test('fetchWithFallback can disable ScraperAPI fallback for bounded deep scans', async () => {
  const originalFetch = globalThis.fetch;
  const originalKeys = [...config.scraperApiKeys];
  const requestedUrls = [];

  config.scraperApiKeys.splice(0, config.scraperApiKeys.length, 'fake-scraper-key');
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return new Response('blocked', { status: 503 });
  };

  try {
    const res = await fetchWithFallback('https://lostark.bible/character/NA/Ainslinn', {
      allowScraperApi: false,
    });

    assert.equal(res.status, 503);
    assert.deepEqual(requestedUrls, ['https://lostark.bible/character/NA/Ainslinn']);
  } finally {
    config.scraperApiKeys.splice(0, config.scraperApiKeys.length, ...originalKeys);
    globalThis.fetch = originalFetch;
  }
});

test('fetchGuildMembers can disable ScraperAPI fallback and cache guild member lists', async () => {
  clearGuildMembersCache();
  const originalFetch = globalThis.fetch;
  const originalKeys = [...config.scraperApiKeys];
  const requestedUrls = [];

  config.scraperApiKeys.splice(0, config.scraperApiKeys.length, 'fake-scraper-key');
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);
    assert.equal(requestedUrl.includes('api.scraperapi.com'), false);

    if (requestedUrl.endsWith('/guild/__data.json')) {
      return Response.json({
        nodes: [
          {
            data: [
              { guild: 1 },
              { members: 2 },
              [6],
              'Guildmate',
              'bard',
              'Member',
              [3, 4, 7, 5, -1],
              1700,
            ],
          },
        ],
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const first = await fetchGuildMembers('Ainslinn', {
      allowScraperApi: false,
      cacheKey: 'AinsGuild',
    });
    const second = await fetchGuildMembers('OtherAlt', {
      allowScraperApi: false,
      cacheKey: 'AinsGuild',
    });

    assert.deepEqual(first, second);
    assert.equal(first.length, 1);
    assert.equal(first[0].name, 'Guildmate');
    assert.deepEqual(requestedUrls, [
      'https://lostark.bible/character/NA/Ainslinn/guild/__data.json',
    ]);
  } finally {
    config.scraperApiKeys.splice(0, config.scraperApiKeys.length, ...originalKeys);
    globalThis.fetch = originalFetch;
    clearGuildMembersCache();
  }
});
