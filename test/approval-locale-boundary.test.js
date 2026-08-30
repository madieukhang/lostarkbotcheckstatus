import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalServices } from '../bot/handlers/list/services/approvals.js';
import { t } from '../bot/services/i18n/index.js';

function createDmUser(id, sentByUser, { bot = false } = {}) {
  return {
    id,
    bot,
    send: async (message) => {
      sentByUser.set(id, message);
      return { channelId: `dm-${id}`, id: `message-${id}` };
    },
  };
}

test('single approval delivery localizes each DM and skips bots or failed recipients', async () => {
  const sentByUser = new Map();
  const users = new Map([
    ['approver-vi', createDmUser('approver-vi', sentByUser)],
    ['approver-jp', createDmUser('approver-jp', sentByUser)],
    ['approver-bot', createDmUser('approver-bot', sentByUser, { bot: true })],
  ]);
  const languages = new Map([
    ['approver-vi', 'vi'],
    ['approver-jp', 'jp'],
  ]);
  const services = createApprovalServices({
    client: {
      users: {
        fetch: async (id) => {
          if (id === 'approver-failed') throw new Error('DM unavailable');
          return users.get(id);
        },
      },
    },
    getUserLanguageFn: async (id) => languages.get(id),
    getApproverRecipientIdsFn: () => [
      'approver-vi',
      'approver-jp',
      'approver-bot',
      'approver-failed',
    ],
  });

  const result = await services.sendListAddApprovalToApprovers(
    { id: 'guild-1', name: 'Test Guild' },
    {
      requestId: 'request-1',
      type: 'black',
      name: 'Testname',
      reason: 'Test reason',
      raid: '',
      scope: 'global',
      requestedByUserId: 'requester-1',
      requestedByDisplayName: 'Requester',
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual([...result.deliveredApproverIds].sort(), ['approver-jp', 'approver-vi']);
  assert.deepEqual(
    result.deliveredDmMessages
      .map(({ approverId, channelId, messageId }) => ({ approverId, channelId, messageId }))
      .sort((a, b) => a.approverId.localeCompare(b.approverId)),
    [
      { approverId: 'approver-jp', channelId: 'dm-approver-jp', messageId: 'message-approver-jp' },
      { approverId: 'approver-vi', channelId: 'dm-approver-vi', messageId: 'message-approver-vi' },
    ],
  );
  assert.equal(sentByUser.has('approver-bot'), false);
  assert.equal(
    sentByUser.get('approver-vi').components[0].toJSON().components[0].label,
    t('common.actions.approve', 'vi'),
  );
  assert.equal(
    sentByUser.get('approver-jp').components[0].toJSON().components[0].label,
    t('common.actions.approve', 'jp'),
  );
});

test('bulk approval delivery keeps the same tracking contract per localized recipient', async () => {
  const sentByUser = new Map();
  const languages = new Map([
    ['senior-en', 'en'],
    ['senior-vi', 'vi'],
  ]);
  const services = createApprovalServices({
    client: {
      users: {
        fetch: async (id) => createDmUser(id, sentByUser),
      },
    },
    getUserLanguageFn: async (id) => languages.get(id),
    getSeniorApproverIdsFn: () => ['senior-en', 'senior-vi'],
  });
  const pending = {
    requestId: 'bulk-request-1',
    requesterId: 'requester-1',
    requesterDisplayName: 'Requester',
    guildId: 'guild-1',
    rows: [
      { type: 'black', name: 'Alpha', reason: 'Reason A', scope: 'global', raid: '' },
      { type: 'white', name: 'Beta', reason: 'Reason B', scope: 'global', raid: '' },
    ],
  };

  const result = await services.sendBulkApprovalToApprovers(
    { id: 'guild-1', name: 'Test Guild' },
    pending,
  );

  assert.equal(result.success, true);
  assert.deepEqual([...result.deliveredApproverIds].sort(), ['senior-en', 'senior-vi']);
  assert.equal(result.deliveredDmMessages.length, 2);
  assert.equal(
    sentByUser.get('senior-en').components[0].toJSON().components[0].label,
    t('common.actions.approveAdd', 'en', { count: pending.rows.length }),
  );
  assert.equal(
    sentByUser.get('senior-vi').components[0].toJSON().components[0].label,
    t('common.actions.approveAdd', 'vi', { count: pending.rows.length }),
  );
});

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
      // Embed titles render no markdown, so buildNoticeEmbed strips the
      // emphasis when it promotes the first line into the title.
      localizedCopy
        .replace(`<@${payload.requestedByUserId}>`, '')
        .replace(/\*\*/g, '')
        .trim()
    )
  );
});
