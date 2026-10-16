import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRosterCharacters,
  detectAltsViaStronghold,
  fetchCharacterMeta,
  fetchGuildMembers,
} from '../bot/services/roster/index.js';
import { fetchWithFallback } from '../bot/services/roster/bibleFetch.js';
import { isBibleRequestFailure, stampRosterWorld } from '../bot/services/roster/buildRosterCharacters.js';
import { clearGuildMembersCache } from '../bot/services/roster/guildMembers.js';
import { extractCharacterItemLevelFromHtml } from '../bot/services/roster/parsers.js';
import config from '../bot/config.js';
import { clearMetaCache } from '../bot/utils/cache/metaCache.js';
import { sleep } from '../bot/utils/async.js';

function createGuildMembersResponse(memberName = 'Guildmate') {
  return Response.json({
    nodes: [{
      data: [
        { guild: 1 },
        { members: 2 },
        [6],
        memberName,
        'bard',
        'Member',
        [3, 4, 7, 5, -1],
        1700,
      ],
    }],
  });
}

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

  // fetchCharacterMeta probes `/__data.json` first and falls back to HTML
  // on parse failure. The mock here returns non-JSON content for the
  // data.json probe so the fallback path runs, exercising both legs in a
  // single test.
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
      'class:"bard",itemLevel:1723.33,world:"Thaemine",rosterLevel:300,stronghold:{level:70,name:"AinsHome"},guild:{name:"AinsGuild",grade:"Member"}',
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
    assert.equal(result.rosterCharacters[0].world, 'Thaemine');
    assert.equal(requestedUrls[0], 'https://lostark.bible/character/NA/Ainslinn/roster');
    assert.equal(requestedUrls[1], 'https://lostark.bible/character/NA/Ainslinn/__data.json');
    assert.equal(requestedUrls[2], 'https://lostark.bible/character/NA/Ainslinn');
    assert.equal(requestedUrls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hidden roster world stamping covers both the primary character and discovered alts', () => {
  assert.deepEqual(
    stampRosterWorld([
      { name: 'Ainslinn' },
      { name: 'Ainsalt', world: 'StaleWorld' },
    ], ' Thaemine '),
    [
      { name: 'Ainslinn', world: 'Thaemine' },
      { name: 'Ainsalt', world: 'Thaemine' },
    ]
  );
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

test('detectAltsViaStronghold records a successful roster match and progress snapshot', async () => {
  clearMetaCache();
  const originalFetch = globalThis.fetch;
  const progressSnapshots = [];

  globalThis.fetch = async () => Response.json({
    nodes: [
      {
        data: [
          { header: 1 },
          { rosterLevel: 2, stronghold: 3, guild: 6, class: 9, ilvl: 10 },
          300,
          { level: 4, name: 5 },
          70,
          'AinsHome',
          { name: 7, grade: 8 },
          'AinsGuild',
          'Member',
          'bard',
          1750,
        ],
      },
    ],
  });

  try {
    const result = await detectAltsViaStronghold('Ainslinn', {
      targetMeta: {
        rosterLevel: 300,
        strongholdLevel: 70,
        strongholdName: 'AinsHome',
        guildName: 'AinsGuild',
        guildGrade: 'Member',
        classId: 'bard',
        itemLevel: 1790,
      },
      guildMembers: [
        { name: 'Ainsalt', cls: 'bard', ilvl: 1750, rank: 'Member' },
      ],
      candidateLimit: 1,
      mode: 'fast',
      concurrency: 1,
      retryOnRateLimit: false,
      useScraperApiForCandidates: false,
      onProgress: (snapshot) => progressSnapshots.push(snapshot),
    });

    assert.equal(result.attemptedCandidates, 1);
    assert.equal(result.checkedCandidates, 1);
    assert.equal(result.failedCandidates, 0);
    assert.deepEqual(result.scannedNames, ['Ainsalt']);
    assert.deepEqual(result.alts.map(({ name }) => name), ['Ainsalt']);
    assert.equal(progressSnapshots.length, 1);
    assert.equal(progressSnapshots[0].altsFound, 1);
    assert.deepEqual(progressSnapshots[0].alts.map(({ name }) => name), ['Ainsalt']);
  } finally {
    globalThis.fetch = originalFetch;
    clearMetaCache();
  }
});

test('detectAltsViaStronghold pauses early on candidate failure storms and retries failed names later', async () => {
  clearMetaCache();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('rate limited', { status: 429 });
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
      guildMembers: [
        { name: 'Failone', cls: 'bard', ilvl: 1800, rank: 'Member' },
        { name: 'Failtwo', cls: 'bard', ilvl: 1790, rank: 'Member' },
      ],
      candidateLimit: 2,
      mode: 'fast',
      concurrency: 1,
      retryOnRateLimit: false,
      failureGuardMinCandidates: 1,
      failureGuardFailedRate: 1,
      useScraperApiForCandidates: false,
    });

    assert.equal(result.pausedForFailureStorm, true);
    assert.equal(result.abortReason, 'bible-failure-storm');
    assert.equal(Object.hasOwn(result, 'abortLabel'), false);
    assert.equal(Object.hasOwn(result, 'abortDetail'), false);
    assert.equal(result.attemptedCandidates, 1);
    assert.equal(result.checkedCandidates, 0);
    assert.equal(result.failedCandidates, 1);
    assert.deepEqual(result.scannedNames, []);
    assert.deepEqual(result.failedNames, ['Failone']);
    assert.equal(result.lastFailureReason, 'HTML HTTP 429');
    assert.deepEqual(result.failureReasons, { 'HTML HTTP 429': 1 });
    assert.equal(fetchCalls, 2);
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
      return createGuildMembersResponse();
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const first = await fetchGuildMembers('Ainslinn', {
      allowScraperApi: false,
      cacheKey: 'AinsGuild',
    });
    const second = await fetchGuildMembers('OtherAlt', {
      allowScraperApi: true,
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

test('fetchGuildMembers isolates policy-distinct in-flight requests', async () => {
  clearGuildMembersCache();
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);
    const memberName = requestedUrl.includes('/StrictCaller/')
      ? 'StrictMember'
      : 'DefaultMember';
    return createGuildMembersResponse(memberName);
  };

  try {
    const [strictMembers, defaultMembers] = await Promise.all([
      fetchGuildMembers('StrictCaller', {
        allowScraperApi: false,
        cacheKey: 'SharedGuild',
      }),
      fetchGuildMembers('DefaultCaller', {
        allowScraperApi: true,
        cacheKey: 'SharedGuild',
      }),
    ]);

    assert.equal(requestedUrls.length, 2);
    assert.equal(strictMembers[0]?.name, 'StrictMember');
    assert.equal(defaultMembers[0]?.name, 'DefaultMember');
  } finally {
    globalThis.fetch = originalFetch;
    clearGuildMembersCache();
  }
});

function emptyGuildMembersResponse() {
  return Response.json({ nodes: [{ data: [{ guild: 1 }, { members: 2 }, []] }] });
}

test('fetchGuildMembers returns null for a failed fetch and [] for a page that lists no one', async (t) => {
  clearGuildMembersCache();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearGuildMembersCache();
  });

  globalThis.fetch = async () => new Response('busy', { status: 503 });
  assert.equal(await fetchGuildMembers('Ainslinn', { cacheKey: 'DownGuild', allowScraperApi: false }), null);

  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  assert.equal(await fetchGuildMembers('Ainslinn', { cacheKey: 'DownGuild', allowScraperApi: false }), null);

  globalThis.fetch = async () => createGuildMembersResponse('Recovered');
  const recovered = await fetchGuildMembers('Ainslinn', { cacheKey: 'DownGuild', allowScraperApi: false });
  assert.deepEqual(recovered.map(({ name }) => name), ['Recovered'], 'a failure must not be cached as the guild list');

  globalThis.fetch = async () => emptyGuildMembersResponse();
  assert.deepEqual(await fetchGuildMembers('Ainslinn', { cacheKey: 'EmptyGuild', allowScraperApi: false }), []);
});

test('detectAltsViaStronghold returns null when the guild member list could not be fetched', async (t) => {
  clearGuildMembersCache();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearGuildMembersCache();
  });
  globalThis.fetch = async () => new Response('busy', { status: 503 });

  const result = await detectAltsViaStronghold('Ainslinn', {
    targetMeta: {
      rosterLevel: 300,
      strongholdLevel: 70,
      strongholdName: 'AinsHome',
      guildName: 'DetectDownGuild',
      guildGrade: 'Member',
      classId: 'bard',
      itemLevel: 1790,
    },
    useScraperApiForCandidates: false,
    allowScraperApiForGuild: false,
  });

  assert.equal(result, null);
});

async function buildWithResponses(t, statusFor) {
  clearMetaCache();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearMetaCache();
  });
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    const status = statusFor(requestedUrl);
    return status === 200
      ? new Response('<html><body><h1>Hidden roster</h1></body></html>', { status })
      : new Response('', { status });
  };
  return buildRosterCharacters('Ainslinn', { hiddenRosterFallback: true });
}

test('buildRosterCharacters reads a 404 roster page as a missing roster, not a failed request', async (t) => {
  const result = await buildWithResponses(t, () => 404);

  assert.equal(result.hasValidRoster, false);
  assert.equal(result.failReason, null);
});

test('buildRosterCharacters reports a failed profile read behind a hidden roster', async (t) => {
  const result = await buildWithResponses(t, (url) => (url.endsWith('/roster') ? 200 : 403));

  assert.equal(result.hasValidRoster, false);
  assert.equal(result.failReason, 'HTTP 403');
});

test('buildRosterCharacters reads a 404 profile behind a hidden roster as a missing character', async (t) => {
  const result = await buildWithResponses(t, (url) => (url.endsWith('/roster') ? 200 : 404));

  assert.equal(result.hasValidRoster, false);
  assert.equal(result.failReason, null);
});

test('isBibleRequestFailure tells failed Bible requests from the 404 that means no such name', () => {
  const cases = [
    { label: 'thrown error', result: { error: new Error('timeout') }, failed: true },
    { label: '200', result: { ok: true, status: 200 }, failed: false },
    { label: '404', result: { ok: false, status: 404 }, failed: false },
    { label: '429', result: { ok: false, status: 429 }, failed: true },
    { label: '503', result: { ok: false, status: 503 }, failed: true },
    { label: 'missing status', result: { ok: false }, failed: true },
  ];
  for (const { label, result, failed } of cases) {
    assert.equal(isBibleRequestFailure(result), failed, label);
  }
});

function createMetaDataResponse() {
  return Response.json({
    nodes: [
      {
        data: [
          { header: 1 },
          { rosterLevel: 2, stronghold: 3, guild: 6, class: 9, ilvl: 10 },
          300,
          { level: 4, name: 5 },
          70,
          'JoinHome',
          { name: 7, grade: 8 },
          'JoinGuild',
          'Member',
          'bard',
          1725.55,
        ],
      },
    ],
  });
}

// The mocked fetch waits so the second caller always arrives while the first
// caller's request is still in flight.
function mockMetaFetch(t, respond) {
  clearMetaCache();
  const originalFetch = globalThis.fetch;
  const state = { calls: 0 };
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearMetaCache();
  });
  globalThis.fetch = async (url) => {
    state.calls += 1;
    await sleep(10);
    return respond(String(url));
  };
  return state;
}

const SHARED_META_OPTIONS = { allowScraperApi: false, retryOnRateLimit: false, timeoutMs: 5000 };

test('fetchCharacterMeta replays a failed shared fetch to the caller that joined it', async (t) => {
  const fetchState = mockMetaFetch(t, () => new Response('busy', { status: 503 }));
  const ownerResults = [];
  const joinerResults = [];

  const [ownerMeta, joinerMeta] = await Promise.all([
    fetchCharacterMeta('JoinOutage', { ...SHARED_META_OPTIONS, onMetaFetchResult: (r) => ownerResults.push(r) }),
    fetchCharacterMeta('JoinOutage', { ...SHARED_META_OPTIONS, onMetaFetchResult: (r) => joinerResults.push(r) }),
  ]);

  assert.equal(ownerMeta, null);
  assert.equal(joinerMeta, null);
  assert.equal(fetchState.calls, 2, 'the joining caller must share the first caller\'s requests');
  assert.deepEqual(ownerResults.map(({ phase, status, ok }) => ({ phase, status, ok })), [
    { phase: '__data.json', status: 503, ok: false },
    { phase: 'HTML', status: 503, ok: false },
  ]);
  assert.deepEqual(joinerResults, ownerResults);
});

test('fetchCharacterMeta replays a successful shared fetch to the caller that joined it', async (t) => {
  const fetchState = mockMetaFetch(t, () => createMetaDataResponse());
  const joinerResults = [];

  const [ownerMeta, joinerMeta, silentMeta] = await Promise.all([
    fetchCharacterMeta('JoinOk', SHARED_META_OPTIONS),
    fetchCharacterMeta('JoinOk', { ...SHARED_META_OPTIONS, onMetaFetchResult: (r) => joinerResults.push(r) }),
    fetchCharacterMeta('JoinOk', SHARED_META_OPTIONS),
  ]);

  assert.equal(fetchState.calls, 1);
  assert.equal(ownerMeta.rosterLevel, 300);
  assert.deepEqual(joinerMeta, ownerMeta);
  assert.deepEqual(silentMeta, ownerMeta);
  assert.deepEqual(joinerResults, [{ name: 'JoinOk', phase: '__data.json', status: 200, ok: true, attempt: 1 }]);
});

test('fetchCharacterMeta replays retryable statuses of a shared fetch to the caller that joined it', async (t) => {
  const fetchState = mockMetaFetch(t, () => (fetchState.calls === 1
    ? new Response('slow down', { status: 429 })
    : createMetaDataResponse()));
  const options = { ...SHARED_META_OPTIONS, retryOnRateLimit: true, rateLimitRetryDelayMs: 1, suppressRetryWarnings: true };
  const ownerRetries = [];
  const joinerRetries = [];

  const [ownerMeta, joinerMeta] = await Promise.all([
    fetchCharacterMeta('JoinRetry', { ...options, onRetryableStatus: (r) => ownerRetries.push(r) }),
    fetchCharacterMeta('JoinRetry', { ...options, onRetryableStatus: (r) => joinerRetries.push(r) }),
  ]);

  assert.equal(fetchState.calls, 2, 'one 429 attempt and one successful retry, shared by both callers');
  assert.equal(ownerMeta.rosterLevel, 300);
  assert.deepEqual(joinerMeta, ownerMeta);
  assert.equal(ownerRetries.length, 1);
  assert.equal(ownerRetries[0].status, 429);
  assert.deepEqual(joinerRetries, ownerRetries);
});

test('concurrent buildRosterCharacters calls both report a failed profile read behind a hidden roster', async (t) => {
  mockMetaFetch(t, (url) => (url.endsWith('/roster')
    ? new Response('<html><body><h1>Hidden roster</h1></body></html>', { status: 200 })
    : new Response('busy', { status: 503 })));
  const options = { ...SHARED_META_OPTIONS, hiddenRosterFallback: true };

  const results = await Promise.all([
    buildRosterCharacters('Outagetest', options),
    buildRosterCharacters('Outagetest', options),
  ]);

  assert.deepEqual(results.map((result) => result.failReason), ['HTTP 503', 'HTTP 503']);
});
