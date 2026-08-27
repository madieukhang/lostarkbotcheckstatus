import test from 'node:test';
import assert from 'node:assert/strict';

import { createRosterScanRuntime } from '../bot/handlers/roster/progress.js';
import { getScan } from '../bot/utils/scanSession.js';

test('roster scan runtime owns registration, initial progress UI, and idempotent cleanup', () => {
  const interaction = { user: { id: 'caller-1' } };
  const runtime = createRosterScanRuntime({
    interaction,
    replyEditor: { edit: async () => {} },
    name: 'Targetname',
    meta: { guildName: 'Test Guild' },
    totalMembers: 42,
    label: 'Targetname (test scan)',
    lang: 'en',
  });

  try {
    const registered = getScan(runtime.sessionId);
    assert.strictEqual(registered.cancelFlag, runtime.cancelFlag);
    assert.equal(registered.callerId, 'caller-1');
    assert.equal(registered.label, 'Targetname (test scan)');

    const leadingEmbed = { title: 'Roster' };
    const payload = runtime.buildInitialPayload({
      title: 'Scanning Targetname',
      subtitle: 'Test Guild',
      totalCandidates: 25,
      content: null,
      leadingEmbeds: [leadingEmbed],
    });

    assert.equal(payload.content, null);
    assert.strictEqual(payload.embeds[0], leadingEmbed);
    assert.equal(payload.embeds.length, 2);
    assert.equal(payload.components.length, 1);
    assert.equal(
      payload.components[0].components[0].data.custom_id,
      `scan-cancel:${runtime.sessionId}`,
    );
  } finally {
    runtime.close();
    runtime.close();
  }

  assert.equal(getScan(runtime.sessionId), undefined);
});
