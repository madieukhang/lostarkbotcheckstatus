import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRosterCharacters } from '../bot/services/rosterService.js';

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
