import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildRosterDeepScanResult } = await import('../bot/handlers/roster/deepResult.js');
const { clearRosterDeepSession, getRosterDeepSession } = await import('../bot/utils/rosterDeepSession.js');
const { buildScanResultEmbed } = await import('../bot/utils/scanResultEmbed.js');
const { rosterUrl } = await import('../bot/utils/rosterLink.js');
const { t } = await import('../bot/services/i18n/index.js');

const altResult = {
  totalEligibleInGuild: 8,
  checkedCandidates: 3,
  scannedCandidates: 3,
  attemptedCandidates: 4,
  failedCandidates: 1,
  scannedNames: ['Memberone'],
  alts: [{ name: 'Altone' }],
};

function withoutTimestamp(embed) {
  const { timestamp, ...json } = embed.toJSON();
  return json;
}

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
        const expected = buildScanResultEmbed({
          target: { name: 'Targetname', isHidden, guildName: meta.guildName, profileUrl: rosterUrl('Targetname') },
          kind: isHidden ? 'roster-hidden' : 'roster-visible',
          result: altResult,
          summaryLine: t('dialogue.enrich.summary', lang, { guild: meta.guildName, name: 'Targetname', resumed: '' }),
          lang,
        });
        assert.deepEqual(withoutTimestamp(output.embed), withoutTimestamp(expected.embed));
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

test('visible results keep the no-guild copy and suppress Continue without member context', () => {
  for (const meta of [null, {}, { guildName: 'Guild with unavailable members' }]) {
    const output = buildRosterDeepScanResult({
      callerId: 'caller-1', name: 'Targetname', isHidden: false, meta, guildMembers: [],
      altResult, canContinue: false, lang: 'en',
      primaryEmbed: { toJSON: () => assert.fail('a non-resumable scan must not capture a session') },
    });
    assert.deepEqual(output.components, []);
    const summary = meta?.guildName
      ? t('dialogue.enrich.summary', 'en', { guild: meta.guildName, name: 'Targetname', resumed: '' })
      : t('dialogue.enrich.noGuild.description', 'en', { name: 'Targetname' });
    assert.ok(output.embed.toJSON().description.includes(summary));
  }
});

test('empty and complete scans never capture a continuation snapshot', () => {
  const options = {
    name: 'Targetname', isHidden: false, meta: { guildName: 'Test Guild' }, lang: 'en',
    primaryEmbed: { toJSON: () => assert.fail('no remaining candidates means no session') },
  };
  assert.deepEqual(buildRosterDeepScanResult({ ...options, altResult: null }), { embed: null, components: [] });
  const completed = buildRosterDeepScanResult({ ...options, altResult: { ...altResult, checkedCandidates: 8 } });
  assert.ok(completed.embed);
  assert.deepEqual(completed.components, []);
});
