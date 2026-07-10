import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalServices } from '../bot/handlers/list/services/approvals.js';
import { t } from '../bot/services/i18n/index.js';

test('approval DM sync rebuilds each message in its recipient language', async () => {
  const edits = new Map();
  const client = {
    channels: {
      fetch: async (channelId) => ({
        isTextBased: () => true,
        messages: {
          fetch: async (messageId) => ({
            edit: async (options) => edits.set(`${channelId}:${messageId}`, options),
          }),
        },
      }),
    },
  };
  const languages = new Map([
    ['approver-a', 'vi'],
    ['approver-b', 'jp'],
  ]);
  const services = createApprovalServices({
    client,
    getUserLanguageFn: async (userId) => languages.get(userId),
  });

  await services.syncApproverDmMessages({
    approverDmMessages: [
      { approverId: 'approver-a', channelId: 'dm-a', messageId: 'message-a' },
      { approverId: 'approver-b', channelId: 'dm-b', messageId: 'message-b' },
    ],
  }, (lang) => ({ content: lang }));

  assert.equal(edits.get('dm-a:message-a').content, 'vi');
  assert.equal(edits.get('dm-b:message-b').content, 'jp');
});

test('approval result posted in a guild channel uses guild-global language', async () => {
  const sent = [];
  const channel = {
    isTextBased: () => true,
    send: async (options) => sent.push(options),
  };
  const guild = {
    id: 'guild-1',
    channels: { fetch: async () => channel },
  };
  const client = {
    guilds: { fetch: async () => guild },
  };
  const services = createApprovalServices({
    client,
    getGuildLanguageFn: async () => 'vi',
  });
  const payload = {
    guildId: guild.id,
    channelId: 'channel-1',
    requestedByUserId: 'requester-1',
    action: 'add',
    name: 'Artist',
  };

  await services.notifyRequesterAboutDecision(payload, {}, false);

  assert.equal(sent.length, 1);
  const localizedCopy = t('dialogue.approval.public.approved', 'vi', {
    user: payload.requestedByUserId,
    action: t('dialogue.approval.public.add', 'vi'),
    name: payload.name,
  });
  assert.equal(sent[0].content, `<@${payload.requestedByUserId}>`);
  assert.deepEqual(sent[0].allowedMentions, { users: [payload.requestedByUserId] });
  assert.equal(sent[0].embeds.length, 1);
  assert.ok(
    sent[0].embeds[0].toJSON().title.includes(
      localizedCopy.replace(`<@${payload.requestedByUserId}>`, '').trim()
    )
  );
});
