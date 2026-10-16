import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildDeepScanNotRunNotice, buildRosterDeepScanResult } = await import('../bot/handlers/roster/deepResult.js');
const { clearRosterDeepSession, getRosterDeepSession } = await import('../bot/utils/rosterDeepSession.js');
const { t } = await import('../bot/services/i18n/index.js');

const altResult = {
  totalEligibleInGuild: 8,
  checkedCandidates: 3,
  attemptedCandidates: 4,
  failedCandidates: 1,
  scannedNames: ['Memberone'],
  alts: [{ name: 'Altone' }],
};

for (const lang of ['vi', 'en', 'jp']) {
  for (const isHidden of [true, false]) {
    test(`${lang} ${isHidden ? 'hidden' : 'visible'} scan preserves the result card and resume context`, () => {
      const meta = { guildName: 'Test Guild' };
      const guildMembers = [{ name: 'Memberone', ilvl: 1710 }];
      const primary = { title: 'Original roster' };
      const output = buildRosterDeepScanResult({
        callerId: 'caller-1', name: 'Targetname', isHidden, meta, guildMembers,
        altResult, cap: 0, primaryEmbed: { toJSON: () => primary }, lang,
      });
      const customId = output.components[0].toJSON().components[0].custom_id;
      assert.match(customId, /^roster-deep:continue:/);
      const sessionId = customId.slice('roster-deep:continue:'.length);
      try {
        assert.equal(output.resumable, true, 'a partial pass with a Continue session is not finished');
        const card = output.embed.toJSON();
        const kindLabel = t(`dialogue.scan.result.kinds.${isHidden ? 'hidden' : 'deep'}`, lang);
        assert.ok(card.title.includes(`${kindLabel} · Targetname`), card.title);
        assert.equal(card.url, 'https://lostark.bible/character/NA/Targetname/roster');
        assert.ok(card.description.includes(
          t('dialogue.enrich.summary', lang, { guild: 'Test Guild', name: 'Targetname', resumed: '' })
        ));
        const session = getRosterDeepSession(sessionId);
        assert.equal(session.callerId, 'caller-1');
        assert.equal(session.targetName, 'Targetname');
        assert.equal(session.isHidden, isHidden);
        assert.strictEqual(session.meta, meta);
        assert.strictEqual(session.guildMembers, guildMembers);
        assert.strictEqual(session.scannedNames, altResult.scannedNames);
        assert.strictEqual(session.allDiscoveredAlts, altResult.alts);
        assert.strictEqual(session.primaryEmbedJSON, primary);
        assert.equal(session.cap, 0);
        assert.deepEqual(session.scanStats, { scanned: 3, attempted: 4, failed: 1, rateLimitRetries: 0 });
      } finally {
        clearRosterDeepSession(sessionId);
      }
    });
  }
}

test('visible results keep the summary and suppress Continue without member context', () => {
  const meta = { guildName: 'Guild with unavailable members' };
  const output = buildRosterDeepScanResult({
    callerId: 'caller-1', name: 'Targetname', isHidden: false, meta, guildMembers: [],
    altResult, canContinue: false, lang: 'en',
    primaryEmbed: { toJSON: () => assert.fail('a non-resumable scan must not capture a session') },
  });
  assert.deepEqual(output.components, []);
  assert.equal(output.resumable, false);
  const summary = t('dialogue.enrich.summary', 'en', { guild: meta.guildName, name: 'Targetname', resumed: '' });
  assert.ok(output.embed.toJSON().description.includes(summary));
});

test('the summary names the scanned guild when the caller had no meta of its own', () => {
  const output = buildRosterDeepScanResult({
    callerId: 'caller-1', name: 'Targetname', isHidden: false, meta: null, guildMembers: [],
    altResult: { ...altResult, target: { guildName: 'Detected Guild' } }, canContinue: false, lang: 'en',
    primaryEmbed: { toJSON: () => assert.fail('a non-resumable scan must not capture a session') },
  });
  const summary = t('dialogue.enrich.summary', 'en', { guild: 'Detected Guild', name: 'Targetname', resumed: '' });
  const card = output.embed.toJSON();
  assert.ok(card.description.includes(summary));
  assert.ok(card.footer.text.includes(t('dialogue.scan.result.footer.guild', 'en', { guild: 'Detected Guild' })), card.footer.text);
});

// The no-guild footer points at `/la-list edit additional_names`, which has
// no entry to act on from a roster card, so that notice carries no footer.
const NOT_RUN_CASES = [
  { cause: 'a target without a guild', input: { meta: {} }, key: 'dialogue.enrich.noGuild', omitsFooter: true },
  {
    cause: 'a target without a guild whose member list also failed',
    input: { meta: {}, guildMembersUnavailable: true },
    key: 'dialogue.enrich.noGuild',
    omitsFooter: true,
  },
  {
    cause: 'a failed guild member fetch',
    input: { meta: { guildName: 'Test Guild' }, guildMembersUnavailable: true },
    key: 'dialogue.enrich.guildUnavailable',
  },
  { cause: 'missing target metadata', input: { meta: null }, key: 'dialogue.enrich.metaMissing' },
  { cause: 'no cause the caller knows', input: { meta: { guildName: 'Test Guild' } }, key: 'dialogue.roster.deepNotRunNotice' },
];

for (const lang of ['en', 'vi', 'jp']) {
  for (const { cause, input, key, omitsFooter } of NOT_RUN_CASES) {
    test(lang + ' deep scan notice for ' + cause + ' uses ' + key, () => {
      const card = buildDeepScanNotRunNotice({ name: 'Targetname', lang, ...input }).toJSON();
      const copy = t(key, lang, { name: 'Targetname' });
      assert.ok(card.title.includes(copy.title), card.title);
      assert.equal(card.description, copy.description);
      assert.equal(card.footer?.text, omitsFooter ? undefined : copy.footer);
    });
  }
}

test('empty and complete scans never capture a continuation snapshot', () => {
  const options = {
    name: 'Targetname', isHidden: false, meta: { guildName: 'Test Guild' }, lang: 'en',
    primaryEmbed: { toJSON: () => assert.fail('no remaining candidates means no session') },
  };
  assert.deepEqual(
    buildRosterDeepScanResult({ ...options, altResult: null }),
    { embed: null, components: [], resumable: false }
  );
  const completed = buildRosterDeepScanResult({ ...options, altResult: { ...altResult, checkedCandidates: 8 } });
  assert.ok(completed.embed);
  assert.deepEqual(completed.components, []);
  assert.equal(completed.resumable, false);
});
