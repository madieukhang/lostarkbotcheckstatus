import test from 'node:test';
import assert from 'node:assert/strict';

import { isApplicationOwner } from '../bot/utils/applicationOwner.js';

function makeClient({ owner = null, fetch } = {}) {
  const application = {
    owner,
    fetchCalls: 0,
    async fetch() {
      application.fetchCalls += 1;
      if (fetch) await fetch(application);
      return application;
    },
  };
  return { application };
}

test('true for the owner user', async () => {
  const client = makeClient({ owner: { id: 'u1' } });
  assert.equal(await isApplicationOwner(client, 'u1'), true);
  assert.equal(client.application.fetchCalls, 0);
});

test('false for another user', async () => {
  const client = makeClient({ owner: { id: 'u1' } });
  assert.equal(await isApplicationOwner(client, 'u2'), false);
});

test('false for a team owner', async () => {
  const client = makeClient({ owner: { id: 'team-1', members: new Map([['u1', {}]]) } });
  assert.equal(await isApplicationOwner(client, 'u1'), false);
});

test('fetches the application when owner is not loaded', async () => {
  const client = makeClient({ fetch: async (application) => { application.owner = { id: 'u1' }; } });
  assert.equal(await isApplicationOwner(client, 'u1'), true);
  assert.equal(client.application.fetchCalls, 1);
});

test('false when the fetch fails', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const client = makeClient({ fetch: async () => { throw new Error('offline'); } });
  assert.equal(await isApplicationOwner(client, 'u1'), false);
});

test('false without a user id or an application', async () => {
  assert.equal(await isApplicationOwner({ application: null }, 'u1'), false);
  assert.equal(await isApplicationOwner(makeClient({ owner: { id: 'u1' } }), ''), false);
});
