import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterCharacters } from '../bot/services/roster/buildRosterCharacters.js';
import { bibleClient } from '../bot/services/roster/bibleClient.js';

// Two users checking one name at once must not queue two roster fetches:
// through the worker the second one waits behind the first, times out and
// falls back to a slower route with a thinner result.
const ROSTER_PAGE = '<html><body><a href="/character/NA/Alpha"><div class="text-lg font-semibold">Alpha '
  + '<span>1740.83</span> <span>≈3264.49</span></div></a>'
  + '<script>roster:[{id:1,name:"Alpha",class:"blade",ilvl:1740.8334,combatPower:{id:1,score:3264.49},'
  + 'combatPowerIsEstimate:true,lastUpdate:1792166510}]</script></body></html>';

function mockBible(t) {
  const requests = [];
  t.mock.method(bibleClient, 'fetch', async (url) => {
    requests.push(String(url));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(ROSTER_PAGE);
  });
  return requests;
}

test('concurrent roster builds for one name share one fetch and get separate copies', async (t) => {
  const requests = mockBible(t);
  const options = { viaWorker: true, retryOnRateLimit: false, timeoutMs: 6000 };

  const [first, second] = await Promise.all([
    buildRosterCharacters('Alpha', options),
    buildRosterCharacters('Alpha', options),
  ]);

  assert.equal(requests.length, 1);
  assert.deepEqual(second, first);
  first.rosterCharacters.push({ name: 'Added by the first caller' });
  assert.equal(second.rosterCharacters.length, 1);
});

test('a roster build after the shared one settled fetches again', async (t) => {
  const requests = mockBible(t);
  await buildRosterCharacters('Alpha', { viaWorker: true });
  await buildRosterCharacters('Alpha', { viaWorker: true });
  assert.equal(requests.length, 2);
});

test('roster builds with their own signals do not share a fetch', async (t) => {
  const requests = mockBible(t);
  await Promise.all([
    buildRosterCharacters('Alpha', { viaWorker: true, signal: AbortSignal.timeout(5000) }),
    buildRosterCharacters('Alpha', { viaWorker: true, signal: AbortSignal.timeout(5000) }),
  ]);
  assert.equal(requests.length, 2);
});

test('roster builds with different options do not share a fetch', async (t) => {
  const requests = mockBible(t);
  await Promise.all([
    buildRosterCharacters('Alpha', { viaWorker: true }),
    buildRosterCharacters('Alpha', { hiddenRosterFallback: true }),
  ]);
  assert.equal(requests.length, 2);
});
