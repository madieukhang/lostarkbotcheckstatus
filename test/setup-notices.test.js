import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/offline-test';
process.env.SENIOR_APPROVER_IDS = 'senior-1';

const { default: config } = await import('../bot/config.js');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { disconnectDB } = await import('../bot/db.js');
const { t, clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { COLORS, ICONS } = await import('../bot/utils/ui.js');
const { buildAlertEmbed } = await import('../bot/utils/alertEmbed.js');
const { SETUP_ACTION_HANDLERS } = await import('../bot/handlers/setup/guildSetup.js');
const { reportMissingChannelPermissions } = await import('../bot/handlers/setup/setupGuards.js');
const { handleSetupRemoteCommand } = await import('../bot/handlers/setup/remote.js');

const fieldPairs = (card) => (card.fields || []).map(({ name, value }) => [name, value]);

function textChannel(id, { lacking = [] } = {}) {
  return {
    id,
    type: ChannelType.GuildText,
    guildId: 'guild-1',
    permissionsFor: () => ({ has: (flag) => !lacking.includes(flag) }),
  };
}

// Runs one /la-setup config action against mocked storage and returns the
// last embed the handler edited in.
async function runSetupAction(context, action, { guildConfig = {}, channel = null, option = null } = {}) {
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => guildConfig }));
  context.mock.method(GuildConfig, 'findOneAndUpdate', () => ({
    lean: async () => guildConfig,
    then: (resolve) => resolve(guildConfig),
  }));
  context.after(disconnectDB);
  const replies = [];
  const interaction = {
    guild: {
      id: 'guild-1',
      name: 'Guild',
      members: { me: { id: 'bot' } },
      channels: { cache: new Map(channel ? [[channel.id, channel]] : []) },
    },
    user: { id: 'admin-1', tag: 'Admin#0001' },
    client: { user: { id: 'bot' } },
    options: { getString: () => option },
    editReply: async (payload) => { replies.push(payload); },
  };
  await SETUP_ACTION_HANDLERS[action](interaction, 'en');
  return replies.at(-1).embeds[0].toJSON();
}

test('/la-setup notify-on is done, with the show command as a plain-text tip', async (context) => {
  const card = await runSetupAction(context, 'notify-on');
  const copy = t('dialogue.setup.notificationsEnabled', 'en');
  assert.equal(card.title, `✅  ${copy.title}`);
  assert.equal(card.color, COLORS.success);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
  assert.match(card.footer.text, /\/la-setup config action:show/);
  assert.doesNotMatch(card.footer.text, /`/);
});

test('/la-setup cleanup-on without an auto-check channel is input with a short title', async (context) => {
  const card = await runSetupAction(context, 'cleanup-on');
  const copy = t('dialogue.setup.autoCleanup.noChannel', 'en');
  assert.equal(card.title, `✏️  ${copy.title}`);
  assert.doesNotMatch(card.title, /la-setup/);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
});

test('/la-setup repin lacking a permission is partial, names what is missing and keeps the channel mention', async (context) => {
  const channel = textChannel('chan-1', { lacking: [PermissionFlagsBits.ManageMessages] });
  const card = await runSetupAction(context, 'repin', { guildConfig: { autoCheckChannelId: 'chan-1' }, channel });
  const copy = t('dialogue.setup.repin.missingPermissions', 'en', { channel: 'chan-1' });
  assert.equal(card.title, `${ICONS.warn}  ${copy.title}`);
  assert.equal(card.color, COLORS.warning);
  assert.equal(card.description, copy.description);
  assert.match(card.description, /<#chan-1>/);
  assert.deepEqual(fieldPairs(card), [[t('dialogue.common.missingField', 'en'), '• Manage Messages']]);
});

test('/la-setup notify-cleanup that stops partway is partial and keeps the channel mention in a titled card', async (context) => {
  context.mock.method(console, 'error', () => {});
  const channel = textChannel('chan-2');
  const card = await runSetupAction(context, 'notify-cleanup', { guildConfig: { listNotifyChannelId: 'chan-2' }, channel });
  const copy = t('dialogue.setup.listNotifyCleanup.manualFailed', 'en', { channel: 'chan-2', count: 0 });
  assert.equal(card.title, `${ICONS.warn}  ${copy.title}`);
  assert.equal(card.description, copy.description);
  assert.match(card.description, /<#chan-2>/);
});

test('/la-setup cleanup-off is done, and partial with the missing permission when the guide cannot be refreshed', async (context) => {
  const copy = t('dialogue.setup.autoCleanup.disabled', 'en');

  const plain = await runSetupAction(context, 'cleanup-off');
  assert.equal(plain.title, `✅  ${copy.title}`);
  assert.deepEqual(fieldPairs(plain), []);
  assert.equal(plain.footer?.text, `💡 ${copy.tip}`);

  const channel = textChannel('chan-3', { lacking: [PermissionFlagsBits.PinMessages] });
  const partial = await runSetupAction(context, 'cleanup-off', { guildConfig: { autoCheckChannelId: 'chan-3' }, channel });
  assert.equal(partial.title, `${ICONS.warn}  ${copy.title}`);
  assert.ok(partial.description.startsWith(copy.description), partial.description);
  assert.ok(partial.description.includes(t('dialogue.setup.autoCleanup.guideNotRefreshed', 'en')), partial.description);
  assert.deepEqual(fieldPairs(partial), [[t('dialogue.common.missingField', 'en'), '• Pin Messages']]);
});

test('/la-setup set-default-scope is done with the scope in the description', async (context) => {
  const card = await runSetupAction(context, 'set-default-scope', { option: 'server' });
  const copy = t('dialogue.setup.defaultScopeSet', 'en', { scope: 'server' });
  assert.equal(card.title, `✅  ${copy.title}`);
  assert.equal(card.description, copy.description);
});

test('a refused channel setup for missing permissions is a guard with a tip', async () => {
  const sent = [];
  await reportMissingChannelPermissions({}, 'en', 'chan-9', ['Pin Messages'], {
    editAlertFn: async (_interaction, options) => { sent.push(options); },
  });
  const card = buildAlertEmbed(sent[0]).toJSON();
  const copy = t('dialogue.common.missingPermissions', 'en', { channel: 'chan-9' });
  assert.equal(card.title, `🔒  ${copy.title}`);
  assert.match(card.description, /<#chan-9>/);
  assert.deepEqual(fieldPairs(card), [[t('dialogue.common.missingField', 'en'), '• Pin Messages']]);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
});

test('/la-remote evidencechannel without a channel is input with a tip', async (context) => {
  const ownerGuildId = config.ownerGuildId;
  config.ownerGuildId = 'owner-guild';
  context.after(() => { config.ownerGuildId = ownerGuildId; });
  clearUserLanguageCache();
  context.after(() => clearUserLanguageCache());
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.after(disconnectDB);
  context.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const replies = [];
  const options = { action: 'evidencechannel' };
  await handleSetupRemoteCommand({
    user: { id: 'senior-1', tag: 'Senior#0001' },
    options: { getString: (name) => options[name] ?? null, getChannel: () => null },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  });
  const card = replies.at(-1).embeds[0].toJSON();
  const copy = t('dialogue.remote.channelRequired', 'en');
  assert.equal(card.title, `✏️  ${copy.title}`);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
});
