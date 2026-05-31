import test from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.BIBLE_WORKER_ENABLED = 'false';

let mongod;
let checkNamesAgainstLists;
let formatCheckResults;
let connectDB;
let RosterSnapshot;
let WorkerHeartbeat;
let Blacklist;
let TrustedUser;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  ({ connectDB } = await import('../bot/db.js'));
  ({ checkNamesAgainstLists, formatCheckResults } = await import('../bot/services/list-check/service.js'));
  ({ default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js'));
  ({ default: WorkerHeartbeat } = await import('../bot/models/WorkerHeartbeat.js'));
  ({ default: Blacklist } = await import('../bot/models/Blacklist.js'));
  ({ default: TrustedUser } = await import('../bot/models/TrustedUser.js'));

  await connectDB();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    RosterSnapshot.deleteMany({}),
    WorkerHeartbeat.deleteMany({}),
    Blacklist.deleteMany({}),
    TrustedUser.deleteMany({}),
  ]);
});

async function markWorkerOnline() {
  await WorkerHeartbeat.create({
    workerId: 'default',
    lastSeenAt: new Date(),
    startedAt: new Date(),
    pid: 12345,
  });
}

function installBibleSearchStub({
  suggestedName = 'Qyoir',
  classId = 'bard',
  itemLevel = 1741.67,
} = {}) {
  const originalFetch = globalThis.fetch;
  const counts = { rosterCalls: 0, searchCalls: 0 };

  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl.includes('/character/NA/')) {
      counts.rosterCalls += 1;
      return new Response('<html><body>No roster here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      counts.searchCalls += 1;
      const data = [[1], [2, 3, 4], suggestedName, classId, itemLevel];
      return Response.json({
        type: 'result',
        result: JSON.stringify(data),
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  return {
    counts,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test('worker-online enrichment canonicalizes the display name to bible spelling', async () => {
  await markWorkerOnline();

  // Roster HTML where bible's spelling is "Morrahduk" but the caller
  // passes an all-caps OCR variant. The targetRecord match is case-
  // insensitive, so it resolves, and the display name should snap to
  // bible's canonical casing.
  const rosterHtml = [
    '<html><body>',
    '<script>name:"Morrahduk",class:"berserker"</script>',
    '<a href="/character/NA/Morrahduk/roster">',
    '  <div class="text-lg font-semibold">Morrahduk<span>1740.00</span><span>4095.16</span></div>',
    '</a>',
    '</body></html>',
  ].join('\n');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/character/NA/')) {
      return new Response(rosterHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      const data = [[1], [2, 3, 4], 'Morrahduk', 'berserker', 1740];
      return Response.json({ type: 'result', result: JSON.stringify(data) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['MORRAHDUK'], { guildId: 'guild-1' });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Morrahduk', 'display name should match bible canonical casing');
    assert.equal(results[0].snapClassName, 'Berserker');
    assert.equal(results[0].snapItemLevel, 1740);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('snapshot lookup does not fold distinct diacritic variants before search', async () => {
  await RosterSnapshot.create({
    name: 'A\u00fcreli\u00e1',
    classId: 'berserker_female',
    itemLevel: 1772.5,
    rosterName: 'A\u00fcreli\u00e1',
  });

  const originalFetch = globalThis.fetch;
  const counts = { searchCalls: 0 };
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      counts.searchCalls += 1;
      const data = [
        [1, 5],
        [2, 3, 4],
        'A\u00fcreli\u00e1',
        'berserker_female',
        1772.5,
        [6, 7, 8],
        'A\u00fcr\u00e9li\u00e0',
        'soul_eater',
        1716.6666,
      ];
      return Response.json({ type: 'result', result: JSON.stringify(data) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['A\u00fcr\u00e9li\u00e0'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(counts.searchCalls, 1, 'distinct accent variants should be verified by bible search');
    assert.equal(results[0].name, 'A\u00fcr\u00e9li\u00e0');
    assert.equal(results[0].snapClassName, 'Souleater');
    assert.equal(results[0].snapItemLevel, 1716.6666);
    assert.match(lines[0], /A\u00fcr\u00e9li\u00e0/);
    assert.doesNotMatch(lines[0], /A\u00fcreli\u00e1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search enrichment refuses ambiguous same-base diacritic variants', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      const data = [
        [1, 5, 9],
        [2, 3, 4],
        'A\u00fcreli\u00e1',
        'berserker_female',
        1772.5,
        [6, 7, 8],
        'A\u00fcr\u00e9l\u00eda',
        'battle_master',
        1721.8334,
        [10, 11, 12],
        'A\u00fcr\u00e9li\u00e0',
        'holyknight_female',
        1716.6666,
      ];
      return Response.json({ type: 'result', result: JSON.stringify(data) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['A\u00fcr\u00e9lia'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'A\u00fcr\u00e9lia');
    assert.equal(results[0].snapClassName, '');
    assert.equal(results[0].snapItemLevel, 0);
    assert.match(lines[0], /A\u00fcr\u00e9lia/);
    assert.doesNotMatch(lines[0], /1772\.50/);
    assert.doesNotMatch(lines[0], /1716\.67/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search enrichment keeps unique nearest marked candidate over unmarked same-base names', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
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
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['Cr\u00faelfighter'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Cr\u00fcelfighter');
    assert.equal(results[0].snapClassName, 'Breaker');
    assert.equal(results[0].snapItemLevel, 1768.3334);
    assert.match(lines[0], /Cr\u00fcelfighter/);
    assert.match(lines[0], /1768\.33/);
    assert.doesNotMatch(lines[0], /Cruelfighter/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search enrichment still resolves exact Crüelfighter and Qiylyn metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      const m = requestedUrl.match(/payload=([^&]+)/);
      const decoded = m ? Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8') : '';
      const q = ((decoded.match(/,"([^"]*)","NA"\]/) || [])[1] || '').toLowerCase();
      if (q.includes('cr')) {
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
      if (q.includes('qiy')) {
        const data = [[1], [2, 3, 4], 'Qiylyn', 'weather_artist', 1753.3334];
        return Response.json({ type: 'result', result: JSON.stringify(data) });
      }
      return Response.json({ type: 'result', result: JSON.stringify([[]]) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['Cr\u00fcelfighter', 'Qiylyn'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 2);
    assert.equal(results[0].snapClassName, 'Breaker');
    assert.equal(results[0].snapItemLevel, 1768.3334);
    assert.equal(results[1].snapClassName, 'Aeromancer');
    assert.equal(results[1].snapItemLevel, 1753.3334);
    assert.match(lines[0], /1768\.33/);
    assert.match(lines[1], /1753\.33/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('party-level context corrects unmarked exact OCR when marked sibling fits the lobby', async () => {
  await RosterSnapshot.insertMany([
    { name: 'Cruelfighter', classId: 'blade', itemLevel: 1640, rosterName: 'Cruelfighter' },
    { name: 'Cr\u00fcelfighter', classId: 'infighter_male', itemLevel: 1768.3334, rosterName: 'Cr\u00fcelfighter' },
    { name: 'Qiylyn', classId: 'weather_artist', itemLevel: 1753.3334, rosterName: 'Qiylyn' },
    { name: 'Seulwa', classId: 'reaper', itemLevel: 1720, rosterName: 'Seulwa' },
    { name: 'Episduk', classId: 'soul_eater', itemLevel: 1748.3334, rosterName: 'Episduk' },
    { name: 'Misoon', classId: 'elemental_master', itemLevel: 1754.1666, rosterName: 'Misoon' },
    { name: 'Leign', classId: 'berserker', itemLevel: 1732.5, rosterName: 'Leign' },
    { name: 'Auroraformyluv', classId: 'bard', itemLevel: 1754.1666, rosterName: 'Auroraformyluv' },
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected enrichment fetch: ${url}`);
  };

  try {
    const results = await checkNamesAgainstLists([
      'Cruelfighter',
      'Qiylyn',
      'Seulwa',
      'Episduk',
      'Misoon',
      'Leign',
      'Auroraformyluv',
    ], { guildId: 'guild-1' });
    const corrected = results[0];
    const lines = formatCheckResults(results);

    assert.equal(corrected.name, 'Cr\u00fcelfighter');
    assert.equal(corrected.snapClassName, 'Breaker');
    assert.equal(corrected.snapItemLevel, 1768.3334);
    assert.match(lines.join('\n'), /Cr\u00fcelfighter/);
    assert.doesNotMatch(lines.join('\n'), /Cruelfighter · `1640\.00`/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('party-level context keeps unmarked exact names when they fit the lobby', async () => {
  await RosterSnapshot.insertMany([
    { name: 'Cruelfighter', classId: 'blade', itemLevel: 1640, rosterName: 'Cruelfighter' },
    { name: 'Cr\u00fcelfighter', classId: 'infighter_male', itemLevel: 1768.3334, rosterName: 'Cr\u00fcelfighter' },
    { name: 'Lowone', classId: 'blade', itemLevel: 1645, rosterName: 'Lowone' },
    { name: 'Lowtwo', classId: 'blade', itemLevel: 1650, rosterName: 'Lowtwo' },
    { name: 'Lowthree', classId: 'blade', itemLevel: 1635, rosterName: 'Lowthree' },
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected enrichment fetch: ${url}`);
  };

  try {
    const results = await checkNamesAgainstLists([
      'Cruelfighter',
      'Lowone',
      'Lowtwo',
      'Lowthree',
    ], { guildId: 'guild-1' });

    assert.equal(results[0].name, 'Cruelfighter');
    assert.equal(results[0].snapClassName, 'Deathblade');
    assert.equal(results[0].snapItemLevel, 1640);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker-online enrichment marks chars as trusted via discoveredAlts when the roster main is trusted', async () => {
  await markWorkerOnline();
  await TrustedUser.create({
    name: 'Clauseduk',
    reason: 'guild officer',
    addedByUserId: 'tester',
    addedByTag: 'tester#0001',
  });

  // Roster HTML: two-char roster (Morrahduk + Clauseduk) so the parser
  // returns both names in `allCharacters`, which the service then mirrors
  // into `item.discoveredAlts`. The trust resolver cross-references the
  // alts against TrustedUser and snaps onto Clauseduk's record.
  const rosterHtml = [
    '<html><body>',
    '<script>name:"Morrahduk",class:"berserker_male"</script>',
    '<script>name:"Clauseduk",class:"lance_master"</script>',
    '<a href="/character/NA/Morrahduk/roster">',
    '  <div class="text-lg font-semibold">Morrahduk<span>1740.00</span><span>4095.16</span></div>',
    '</a>',
    '<a href="/character/NA/Clauseduk/roster">',
    '  <div class="text-lg font-semibold">Clauseduk<span>1754.17</span><span>4632.64</span></div>',
    '</a>',
    '</body></html>',
  ].join('\n');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/character/NA/')) {
      return new Response(rosterHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      const data = [[1], [2, 3, 4], 'Morrahduk', 'berserker_male', 1740];
      return Response.json({ type: 'result', result: JSON.stringify(data) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['Morrahduk'], { guildId: 'guild-1' });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Morrahduk');
    assert.ok(
      results[0].trustedEntry,
      'expected Morrahduk to inherit trust via Clauseduk on the shared roster'
    );
    assert.equal(results[0].trustedEntry.name, 'Clauseduk');
    const lines = formatCheckResults(results);
    assert.match(lines[0], /🛡️/, 'rendered line should use the shield icon');
    assert.doesNotMatch(lines[0], /💚/, 'heart icon should no longer render');
  } finally {
    globalThis.fetch = originalFetch;
    await TrustedUser.deleteMany({});
  }
});

// Stub that resolves the empty roster page (forces search-direct), returns
// empty for full-name search, and serves prefix-query candidates so the
// prefix-indel recovery path can be exercised. `prefixResponses` maps a
// lowercase query string to the bible result array.
function installPrefixIndelStub(prefixResponses) {
  const originalFetch = globalThis.fetch;
  const counts = { searchCalls: 0, queries: [] };
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/character/NA/')) {
      return new Response('<html><body>No roster here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      counts.searchCalls += 1;
      const m = requestedUrl.match(/payload=([^&]+)/);
      const decoded = m ? Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8') : '';
      const q = ((decoded.match(/,"([^"]*)","NA"\]/) || [])[1] || '').toLowerCase();
      counts.queries.push(q);
      const result = prefixResponses[q];
      return Response.json({
        type: 'result',
        result: JSON.stringify(result || [[]]),
      });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };
  return { counts, restore() { globalThis.fetch = originalFetch; } };
}

test('prefix-indel recovery resolves a doubled letter (Qiyllyn -> Qiylyn)', async () => {
  await markWorkerOnline();
  const stub = installPrefixIndelStub({
    qiyl: [[1], [2, 3, 4], 'Qiylyn', 'weather_artist', 1751.67],
  });
  try {
    const results = await checkNamesAgainstLists(['Qiyllyn'], { guildId: 'guild-1' });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Qiylyn', 'should recover canonical via prefix-indel');
    assert.equal(results[0].snapItemLevel, 1751.67);
  } finally {
    stub.restore();
  }
});

test('prefix-indel recovery picks the unique distance-1 candidate (Lpiiv -> Lpiiiv, not Lpiiiiv)', async () => {
  await markWorkerOnline();
  // prefix "lpii" returns Lpiiiv (dist 1, recover) AND Lpiiiiv (dist 2,
  // excluded by the strict indel gate · length differs by 2).
  const stub = installPrefixIndelStub({
    lpii: [[1, 5], [2, 3, 4], 'Lpiiiv', 'holyknight', 1730, [6, 7, 8], 'Lpiiiiv', 'berserker', 1660],
  });
  try {
    const results = await checkNamesAgainstLists(['Lpiiv'], { guildId: 'guild-1' });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Lpiiiv', 'should pick the single distance-1 indel candidate');
    assert.equal(results[0].snapItemLevel, 1730);
  } finally {
    stub.restore();
  }
});

test('prefix-indel recovery uses longer prefixes when 4-char search is too broad', async () => {
  await markWorkerOnline();
  const stub = installPrefixIndelStub({
    auro: [[1], [2, 3, 4], 'Auroñ', 'berserker', 1767.5],
    aurorafo: [[1], [2, 3, 4], 'Auroraformyluv', 'bard', 1754.17],
  });
  try {
    const results = await checkNamesAgainstLists(['Aurorafomyluv'], { guildId: 'guild-1' });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Auroraformyluv');
    assert.equal(results[0].snapClassName, 'Bard');
    assert.equal(results[0].snapItemLevel, 1754.17);
    assert.ok(stub.counts.queries.includes('aurorafo'), 'expected longer-prefix recovery query');
  } finally {
    stub.restore();
  }
});

test('prefix-transposition recovery resolves adjacent swapped letters (Auroraforymluv -> Auroraformyluv)', async () => {
  await markWorkerOnline();
  const stub = installPrefixIndelStub({
    auro: [[1], [2, 3, 4], 'Auroraformyluv', 'yinyangshi', 1740],
  });
  try {
    const results = await checkNamesAgainstLists(['Auroraforymluv'], { guildId: 'guild-1' });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Auroraformyluv');
    assert.equal(results[0].snapClassName, 'Artist');
    assert.equal(results[0].snapItemLevel, 1740);
  } finally {
    stub.restore();
  }
});

test('canonical recovery refreshes list hits before rendering not-listed', async () => {
  await markWorkerOnline();
  await Blacklist.create({
    name: 'Auroraformyluv',
    reason: 'prior evidence',
    addedByUserId: 'tester',
    addedByTag: 'tester#0001',
  });
  const stub = installPrefixIndelStub({
    auro: [[1], [2, 3, 4], 'Auroraformyluv', 'bard', 1754.17],
  });
  try {
    const results = await checkNamesAgainstLists(['Auroraforymluv'], { guildId: 'guild-1' });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Auroraformyluv');
    assert.equal(results[0].blackEntry?.name, 'Auroraformyluv');
    assert.equal(results[0].blackEntry?.reason, 'prior evidence');
  } finally {
    stub.restore();
  }
});

test('worker-online discovered alts refresh list hits before Quick Add', async () => {
  await markWorkerOnline();
  await Blacklist.create({
    name: 'Auroraforyou',
    reason: 'same roster evidence',
    addedByUserId: 'tester',
    addedByTag: 'tester#0001',
  });

  const rosterHtml = [
    '<html><body>',
    '<script>name:"Auroraforyou",class:"bard"</script>',
    '<script>name:"Auroraformyluv",class:"bard"</script>',
    '<a href="/character/NA/Auroraforyou/roster">',
    '  <div class="text-lg font-semibold">Auroraforyou<span>1770.00</span><span>5868.87</span></div>',
    '</a>',
    '<a href="/character/NA/Auroraformyluv/roster">',
    '  <div class="text-lg font-semibold">Auroraformyluv<span>1754.17</span><span>5144.30</span></div>',
    '</a>',
    '</body></html>',
  ].join('\n');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/character/NA/')) {
      return new Response(rosterHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['Auroraformyluv'], { guildId: 'guild-1' });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Auroraformyluv');
    assert.equal(results[0].blackEntry?.name, 'Auroraforyou');
    assert.ok(results[0].discoveredAlts.includes('Auroraforyou'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('diaeresis-digraph recovery resolves OCR-collapsed iy names (Qïlyn -> Qiylyn)', async () => {
  await markWorkerOnline();

  const originalFetch = globalThis.fetch;
  const searchQueries = [];
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/character/NA/')) {
      return new Response('<html><body>No roster here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      const payloadMatch = requestedUrl.match(/payload=([^&]+)/);
      const decoded = payloadMatch
        ? Buffer.from(decodeURIComponent(payloadMatch[1]), 'base64').toString('utf8')
        : '';
      const query = ((decoded.match(/,"([^"]*)","NA"\]/) || [])[1] || '');
      searchQueries.push(query);
      if (query.toLowerCase() === 'qiylyn') {
        const data = [[1], [2, 3, 4], 'Qiylyn', 'weather_artist', 1751.67];
        return Response.json({ type: 'result', result: JSON.stringify(data) });
      }
      return Response.json({ type: 'result', result: JSON.stringify([[]]) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['Qïlyn'], { guildId: 'guild-1' });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Qiylyn');
    assert.equal(results[0].snapClassName, 'Aeromancer');
    assert.equal(results[0].snapItemLevel, 1751.67);
    assert.ok(searchQueries.includes('Qiylyn'), 'expected an iy-expanded retry query');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prefix-indel recovery rejects a same-length substitution (Viatchu stays bare, not Viatchy)', async () => {
  await markWorkerOnline();
  // prefix "viat" returns Viatchy · a real but DIFFERENT player one
  // substitution away (u<->y). Same length, so the indel gate rejects it
  // and the row renders bare rather than mis-resolving.
  const stub = installPrefixIndelStub({
    viat: [[1], [2, 3, 4], 'Viatchy', 'berserker_female', 1680],
  });
  try {
    const results = await checkNamesAgainstLists(['Viatchu'], { guildId: 'guild-1' });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Viatchu', 'OCR name unchanged · no unsafe substitution match');
    assert.equal(results[0].snapItemLevel, 0, 'no item level · row stays bare');
    assert.equal(results[0].snapClassName, '', 'no class · row stays bare');
  } finally {
    stub.restore();
  }
});

test('worker-online enrichment falls back to bible search canonical names', async () => {
  await markWorkerOnline();
  const stub = installBibleSearchStub();

  try {
    const results = await checkNamesAgainstLists(['Qy\u00F6ir'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Qyoir');
    assert.equal(results[0].snapClassName, 'Bard');
    assert.equal(results[0].snapItemLevel, 1741.67);
    assert.match(lines[0], /Qyoir/);
    assert.doesNotMatch(lines[0], /Qy\u00F6ir/);
    assert.equal(stub.counts.rosterCalls, 1);
    assert.equal(stub.counts.searchCalls, 1);

    const snapshot = await RosterSnapshot.findOne({ name: 'Qyoir' }).lean();
    assert.equal(snapshot?.itemLevel, 1741.67);
    assert.equal(snapshot?.classId, 'bard');
  } finally {
    stub.restore();
  }
});

test('search canonical names are normalized before rendering', async () => {
  await markWorkerOnline();
  const stub = installBibleSearchStub({
    suggestedName: 'B\u00E1nhcanhc\u00F9a',
    itemLevel: 1760,
  });

  try {
    const results = await checkNamesAgainstLists(['B\u00E1nhcanhc\u00FCa'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'B\u00E1nhcanhc\u00FCa');
    assert.equal(results[0].snapClassName, 'Bard');
    assert.equal(results[0].snapItemLevel, 1760);
    assert.match(lines[0], /B\u00E1nhcanhc\u00FCa/);
    assert.doesNotMatch(lines[0], /B\u00E1nhcanhc\u00F9a/);
    assert.equal(stub.counts.rosterCalls, 1);
    assert.equal(stub.counts.searchCalls, 1);
  } finally {
    stub.restore();
  }
});

test('worker-online enrichment falls back to search when the worker fetch errors out', async () => {
  await markWorkerOnline();

  const originalFetch = globalThis.fetch;
  const counts = { rosterCalls: 0, searchCalls: 0 };
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/character/NA/')) {
      counts.rosterCalls += 1;
      throw new Error('simulated worker timeout');
    }
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      counts.searchCalls += 1;
      const data = [[1], [2, 3, 4], 'Bánhcanhcüa', 'lance_master', 1760];
      return Response.json({ type: 'result', result: JSON.stringify(data) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['Bánhcanhcüa'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Bánhcanhcüa');
    assert.equal(results[0].snapClassName, 'Glaivier');
    assert.equal(results[0].snapItemLevel, 1760);
    assert.match(lines[0], /1760/);
    assert.equal(counts.rosterCalls, 1);
    assert.equal(counts.searchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search retries with ASCII fold when the first query returns empty', async () => {
  await markWorkerOnline();

  const originalFetch = globalThis.fetch;
  const counts = { rosterCalls: 0, searchCalls: 0, foldedHit: false };
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl.includes('/character/NA/')) {
      counts.rosterCalls += 1;
      return new Response('<html><body>No roster here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      counts.searchCalls += 1;
      const payloadMatch = requestedUrl.match(/payload=([^&]+)/);
      const decoded = payloadMatch
        ? Buffer.from(decodeURIComponent(payloadMatch[1]), 'base64').toString('utf8')
        : '';
      // First call carries the full-Unicode name and returns empty
      // (simulating bible's NFD / Cyrillic-confusable miss). The retry
      // carries the ASCII-folded "banhcanhcua" and returns the
      // canonical row.
      if (decoded.includes('banhcanhcua') && !decoded.includes('Bánhcanhcüa')) {
        counts.foldedHit = true;
        const data = [[1], [2, 3, 4], 'Bánhcanhcüa', 'lance_master', 1760];
        return Response.json({ type: 'result', result: JSON.stringify(data) });
      }
      return Response.json({ type: 'result', result: JSON.stringify([[]]) });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  try {
    const results = await checkNamesAgainstLists(['Bánhcanhcüa'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Bánhcanhcüa');
    assert.equal(results[0].snapClassName, 'Glaivier');
    assert.equal(results[0].snapItemLevel, 1760);
    assert.match(lines[0], /1760/);
    assert.equal(counts.searchCalls, 2, 'expected first search + ASCII-fold retry');
    assert.equal(counts.foldedHit, true, 'ASCII-fold retry should resolve the canonical row');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker-online canonicalization repairs short i/l look-alike names', async () => {
  await markWorkerOnline();
  const stub = installBibleSearchStub();

  try {
    const results = await checkNamesAgainstLists(['Qyolr'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Qyoir');
    assert.equal(results[0].snapClassName, 'Bard');
    assert.equal(results[0].snapItemLevel, 1741.67);
    assert.match(lines[0], /Qyoir/);
    assert.doesNotMatch(lines[0], /Qyolr/);
    assert.equal(stub.counts.rosterCalls, 1);
    assert.equal(stub.counts.searchCalls, 1);
  } finally {
    stub.restore();
  }
});
