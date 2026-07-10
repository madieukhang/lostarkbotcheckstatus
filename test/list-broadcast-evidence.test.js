import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  BROADCAST_EVIDENCE_PREFIX,
  buildBroadcastEvidenceComponents,
  createBroadcastEvidenceButtonHandler,
} = await import('../bot/handlers/list/evidence/broadcastButton.js');

test('broadcast evidence uses a compact refreshable button for rehosted images', () => {
  const rows = buildBroadcastEvidenceComponents({
    imageChannelId: '123456789',
    imageMessageId: '987654321',
  });

  assert.equal(rows.length, 1);
  const button = rows[0].components[0].toJSON();
  assert.equal(button.custom_id, `${BROADCAST_EVIDENCE_PREFIX}:123456789:987654321`);
  assert.equal(button.label, 'View evidence');
  assert.equal(button.emoji.name, '📎');
});

test('broadcast evidence keeps a link fallback for legacy direct URLs', () => {
  const rows = buildBroadcastEvidenceComponents({
    imageUrl: 'https://cdn.example.test/evidence.png',
  });

  assert.equal(rows.length, 1);
  const button = rows[0].components[0].toJSON();
  assert.equal(button.url, 'https://cdn.example.test/evidence.png');
  assert.equal(button.label, 'Open evidence');
});

test('broadcast evidence handler acknowledges before refreshing and returns the full image privately', async () => {
  const calls = [];
  let editedPayload;
  const handler = createBroadcastEvidenceButtonHandler({
    client: { id: 'client' },
    refreshImageUrlFn: async (messageId, channelId) => {
      calls.push(`refresh:${channelId}/${messageId}`);
      return 'https://cdn.example.test/fresh.png';
    },
  });
  const interaction = {
    customId: `${BROADCAST_EVIDENCE_PREFIX}:123456789:987654321`,
    async deferReply(options) { calls.push(`defer:${options.flags}`); },
    async editReply(payload) { editedPayload = payload; },
  };

  await handler(interaction);

  assert.deepEqual(calls, [
    `defer:${MessageFlags.Ephemeral}`,
    'refresh:123456789/987654321',
  ]);
  const embed = editedPayload.embeds[0].toJSON();
  assert.equal(embed.image.url, 'https://cdn.example.test/fresh.png');
  assert.match(embed.title, /Evidence/);
  assert.match(embed.description, /broadcast stays easy to read/i);
});

test('broadcast evidence handler explains when archived evidence is gone', async () => {
  let editedPayload;
  const handler = createBroadcastEvidenceButtonHandler({
    client: {},
    refreshImageUrlFn: async () => null,
  });

  await handler({
    customId: `${BROADCAST_EVIDENCE_PREFIX}:123:456`,
    async deferReply() {},
    async editReply(payload) { editedPayload = payload; },
  });

  const embed = editedPayload.embeds[0].toJSON();
  assert.match(embed.title, /Evidence slipped away/i);
  assert.match(embed.description, /deleted|access/i);
});

test('broadcast evidence button uses the clicker language, not the message author language', async () => {
  let resolvedUserId = null;
  let editedPayload;
  const handler = createBroadcastEvidenceButtonHandler({
    client: {},
    refreshImageUrlFn: async () => null,
    getUserLanguageFn: async (userId) => {
      resolvedUserId = userId;
      return 'vi';
    },
  });

  await handler({
    user: { id: 'clicker-b' },
    customId: `${BROADCAST_EVIDENCE_PREFIX}:123:456`,
    async deferReply() {},
    async editReply(payload) { editedPayload = payload; },
  });

  assert.equal(resolvedUserId, 'clicker-b');
  assert.match(editedPayload.embeds[0].toJSON().title, /bằng chứng|evidence/i);
});
