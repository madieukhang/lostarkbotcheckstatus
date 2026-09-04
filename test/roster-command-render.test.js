import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildVisibleRosterLines,
  formatItemLevelDelta,
  formatVisibleRosterLine,
  rosterCardColor,
} = await import('../bot/handlers/roster/command.js');
const { resolveRosterScanOutcome } = await import('../bot/handlers/roster/completion.js');
const { mergeContinuationScanResult } = await import('../bot/handlers/roster/deepContinue.js');
const { buildHiddenFields } = await import('../bot/handlers/roster/hiddenRoster.js');
const { statMapFromRosterCharacters } = await import('../bot/handlers/list/trackedAltsRender.js');

test('/la-roster renders CP as a code badge with the unit after the score', () => {
  const line = formatVisibleRosterLine({
    name: 'Aresvn',
    itemLevel: '1790',
    combatScore: '≈6180.57',
  }, 0, {
    classPrefix: '<:paladin:42>',
    delta: ' *(+10.00)*',
  });

  assert.equal(
    line,
    '**1.** <:paladin:42> Aresvn · `1790` *(+10.00)* · `≈6180.57 CP`'
  );
});

test('/la-roster item-level delta keeps signed two-decimal formatting', () => {
  assert.equal(formatItemLevelDelta('1,790', 1780), ' *(+10.00)*');
  assert.equal(formatItemLevelDelta('1762.5', 1763.33), ' *(-0.83)*');
  assert.equal(formatItemLevelDelta('1700', 1700), '');
  assert.equal(formatItemLevelDelta('1700', 0), '');
});

test('/la-roster visible rows reuse snapshot deltas without mutating input', () => {
  const characters = [{
    name: 'Aresvn',
    className: 'Paladin',
    itemLevel: '1790',
    combatScore: '≈6180.57',
  }];
  const snapshots = new Map([['aresvn', { itemLevel: 1780 }]]);

  const [line] = buildVisibleRosterLines(characters, snapshots, 'en');

  assert.match(line, /Aresvn/);
  assert.match(line, /\*\(\+10\.00\)\*/);
  assert.equal(characters[0].itemLevel, '1790');
});

const HIDDEN_META = {
  guildName: 'AinsGuild',
  world: 'Thaemine',
  strongholdName: 'AinsHome',
  strongholdLevel: 70,
  rosterLevel: 300,
};

test('/la-roster hidden card lays its six facts out on whole rows', () => {
  // These were a paragraph of prose, and the Server line inside it was
  // the last `**Server:** \`X\`` left anywhere in the bot.
  const fields = buildHiddenFields({
    meta: HIDDEN_META,
    guildMembers: new Array(48).fill({}),
    hits: { black: [], white: [] },
    deep: false,
    lang: 'en',
  });

  assert.deepEqual(fields.map((f) => [f.name, f.value]), [
    ['🏛️ Guild', '`AinsGuild`'],
    ['👥 Members', '`48`'],
    ['🌍 Server', '`Thaemine`'],
    ['🏰 Stronghold', '`AinsHome` · `Lv.70`'],
    ['📈 Roster', '`Lv.300`'],
    ['🔬 Deep scan', '`Not run`'],
  ]);
  assert.equal(fields.every((f) => f.inline), true);
  assert.equal(fields.length % 3, 0, 'six facts fill two whole rows');
});

test('/la-roster hidden card omits the server slot when metadata has no world', () => {
  const fields = buildHiddenFields({
    meta: { ...HIDDEN_META, world: undefined },
    guildMembers: [],
    hits: { black: [], white: [] },
    deep: true,
    lang: 'en',
  });

  assert.equal(fields.some((f) => f.name.includes('Server')), false);
  // Five left, so the grid pads rather than stretching a lone field.
  assert.equal(fields.filter((f) => f.inline).length % 3, 0);
  assert.equal(fields.find((f) => f.name.includes('Deep scan')).value, '`Done`');
});

test('/la-roster hidden hits carry class, ilvl and a badged raid', () => {
  const fields = buildHiddenFields({
    meta: HIDDEN_META,
    guildMembers: new Array(48).fill({}),
    hits: {
      black: [{ name: 'Lungzhu', reason: 'zdps', raid: 'Kazeros Nor' }],
      white: [],
    },
    deep: false,
    lang: 'en',
    statMap: statMapFromRosterCharacters([
      { name: 'Lungzhu', className: 'Bard', itemLevel: 1737.5 },
    ]),
  });
  const hit = fields.find((f) => !f.inline);

  // Whoever reads this is deciding on a raid invite, so the row carries
  // what that needs · it used to be bold plain text and a bracketed raid.
  assert.match(hit.name, /Blacklisted guild members \(1\)/u);
  assert.match(hit.value, /\*\*1\.\*\* Bard \*\*\[Lungzhu\]\(\S+\)\*\* · `1737\.50` · `Kazeros Nor`/u);
  assert.match(hit.value, /\nzdps$/u);
});

test('/la-roster card color keeps blacklist-first outcome priority', () => {
  assert.equal(rosterCardColor({ blacklist: {}, whitelist: {}, trusted: {} }), 0xed4245);
  assert.equal(rosterCardColor({ blacklist: null, whitelist: {}, trusted: {} }), 0x57f287);
  assert.equal(rosterCardColor({ blacklist: null, whitelist: null, trusted: {} }), 0x57d6a1);
  assert.equal(rosterCardColor({ blacklist: null, whitelist: null, trusted: null }), 0x5865f2);
});

test('roster scan completion outcome is shared across terminal entry points', () => {
  assert.equal(resolveRosterScanOutcome(null), null);
  assert.equal(resolveRosterScanOutcome({ alts: [] }), 'no-alts');
  assert.equal(resolveRosterScanOutcome({ alts: [{ name: 'Alt' }] }), 'completed');
  assert.equal(resolveRosterScanOutcome({ cancelled: true, alts: [] }), 'stopped-no-alts');
  assert.equal(
    resolveRosterScanOutcome({ pausedForFailureStorm: true, alts: [{ name: 'Alt' }] }),
    'stopped-with-alts'
  );
  assert.equal(resolveRosterScanOutcome({ alts: [] }, { hasRemaining: true }), null);
});

test('continued roster passes merge alts and accumulate scan counters once', () => {
  const session = {
    allDiscoveredAlts: [{ name: 'Existing', itemLevel: 1700 }],
    scannedNames: ['Existing'],
    scanStats: { scanned: 1, attempted: 2, failed: 1, rateLimitRetries: 1 },
  };
  const cumulative = mergeContinuationScanResult(session, {
    alts: [
      { name: 'existing', itemLevel: 1710 },
      { name: 'NewAlt', itemLevel: 1720 },
    ],
    scannedNames: ['NewAlt'],
    scannedCandidates: 1,
    attemptedCandidates: 2,
    failedCandidates: 1,
    rateLimitRetries: 2,
  });

  assert.deepEqual(cumulative.alts.map((alt) => alt.name), ['existing', 'NewAlt']);
  assert.equal(cumulative.alts[0].itemLevel, 1710);
  assert.deepEqual(cumulative.scannedNames, ['Existing', 'NewAlt']);
  assert.equal(cumulative.scannedCandidates, 2);
  assert.equal(cumulative.attemptedCandidates, 4);
  assert.equal(cumulative.failedCandidates, 2);
  assert.equal(cumulative.rateLimitRetries, 3);
});
