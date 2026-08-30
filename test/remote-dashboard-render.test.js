import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildRemoteServerEmbed } = await import('../bot/handlers/setup/remote.js');

test('remote dashboard owner card keeps channel and cleanup settings together', () => {
  const embed = buildRemoteServerEmbed(
    { id: 'guild-1', name: 'Thaemine' },
    {
      globalNotifyEnabled: false,
      defaultBlacklistScope: 'server',
      autoCheckChannelId: 'auto-1',
      autoCheckCleanupEnabled: true,
      listNotifyChannelId: 'notify-1',
      listNotifyCleanupEnabled: true,
      evidenceChannelId: 'evidence-1',
      updatedByTag: 'Traine',
      updatedAt: new Date('2026-08-31T00:00:00Z'),
    },
    { isOwner: true, lang: 'en' }
  ).toJSON();

  assert.match(embed.title, /Thaemine/);
  assert.match(embed.description, /guild-1/);
  assert.equal(embed.fields.length, 9);
  assert.ok(embed.fields.some((field) => field.value === '<#auto-1>'));
  assert.ok(embed.fields.some((field) => field.value === '<#notify-1>'));
  assert.ok(embed.fields.some((field) => field.value === '<#evidence-1>'));
});

test('remote dashboard unconfigured card renders stable defaults', () => {
  const embed = buildRemoteServerEmbed(
    { id: 'guild-2', name: 'Alt Server' },
    null,
    { lang: 'vi' }
  ).toJSON();

  assert.match(embed.title, /Alt Server/);
  assert.equal(embed.fields.length, 8);
  assert.match(embed.description, /guild-2/);
});
