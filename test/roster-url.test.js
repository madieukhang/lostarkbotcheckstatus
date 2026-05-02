import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRosterCharacters,
  extractCharacterItemLevelFromHtml,
  fetchWithFallback,
} from '../bot/services/rosterService.js';
import config from '../bot/config.js';

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

  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    requestedUrls.push(requestedUrl);

    if (requestedUrl.endsWith('/roster')) {
      return new Response('<html><body><h1>Hidden roster</h1></body></html>', { status: 200 });
    }

    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      return Response.json({
        type: 'result',
        result: JSON.stringify([[1], [2, 3, 4], 'Ainslinn', 'bard', 1723.33]),
      });
    }

    return new Response(
      'class:"bard",itemLevel:1686.66,rosterLevel:300,stronghold:{level:70,name:"AinsHome"},guild:{name:"AinsGuild",grade:"Member"}',
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
    assert.equal(requestedUrls[1], 'https://lostark.bible/character/NA/Ainslinn');
    assert.match(requestedUrls[2], /^https:\/\/lostark\.bible\/_app\/remote\/ngsbie\/search\?payload=/);
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
