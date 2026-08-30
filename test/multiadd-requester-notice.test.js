import test from 'node:test';
import assert from 'node:assert/strict';

import { notifyMultiaddRequester } from '../bot/handlers/list/multiadd/approvalButton.js';

function makePayload() {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    requestedByUserId: 'user-1',
  };
}

test('multiadd requester notice centralizes mention, locale, notice, and extra embeds', async () => {
  const sent = [];
  const channel = {
    isTextBased: () => true,
    send: async (payload) => sent.push(payload),
  };
  const client = {
    guilds: {
      fetch: async () => ({
        id: 'guild-1',
        channels: { fetch: async () => channel },
      }),
    },
  };

  const delivered = await notifyMultiaddRequester({
    client,
    payload: makePayload(),
    copyKey: 'approved',
    copyValues: { count: 3 },
    severity: 'success',
    buildExtraEmbeds: (lang) => [{ kind: 'summary', lang }],
    failureLabel: 'failed',
    getGuildLanguageFn: async () => 'vi',
    translate: (key, lang, values) => `<@${values.user}> ${key}:${lang}:${values.count}`,
    buildNoticeEmbedFn: (copy, options) => ({ kind: 'notice', copy, options }),
  });

  assert.equal(delivered, true);
  assert.deepEqual(sent, [{
    content: '<@user-1>',
    allowedMentions: { users: ['user-1'] },
    embeds: [
      {
        kind: 'notice',
        copy: 'approved:vi:3',
        options: { severity: 'success', lang: 'vi' },
      },
      { kind: 'summary', lang: 'vi' },
    ],
  }]);
});

test('multiadd requester notice keeps delivery failures non-fatal', async () => {
  const warnings = [];
  const delivered = await notifyMultiaddRequester({
    client: { guilds: { fetch: async () => { throw new Error('DM bridge unavailable'); } } },
    payload: makePayload(),
    copyKey: 'approved',
    severity: 'success',
    failureLabel: 'notice failed:',
    logger: { warn: (...args) => warnings.push(args) },
  });

  assert.equal(delivered, false);
  assert.deepEqual(warnings, [['notice failed:', 'DM bridge unavailable']]);
});
