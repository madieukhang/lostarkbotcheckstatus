import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import GuildConfig from '../bot/models/GuildConfig.js';
import { disconnectDB } from '../bot/db.js';
import { getSupportedLanguages, t } from '../bot/services/i18n/index.js';
import { COLORS } from '../bot/utils/ui.js';
import { AlertSeverity, buildAlertEmbed, buildNoticeEmbed } from '../bot/utils/alertEmbed.js';
import {
  SETUP_ACTION_HANDLERS,
  buildChannelSetResult,
  welcomeOutcomeText,
} from '../bot/handlers/setup/guildSetup.js';

test('/la-setup language renders a localized embed in every supported language', async (context) => {
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(GuildConfig, 'updateOne', async () => ({}));
  // No auto-check or notify channel, so the handler skips the pin refresh.
  context.mock.method(GuildConfig, 'findOneAndUpdate', () => ({
    lean: async () => ({ guildId: 'guild-1' }),
  }));
  context.after(disconnectDB);

  for (const language of getSupportedLanguages()) {
    const replies = [];
    await SETUP_ACTION_HANDLERS['set-language']({
      guild: { id: 'guild-1' },
      user: { id: 'admin-1', tag: 'Admin#0001' },
      options: { getString: () => language.code },
      editReply: async (payload) => { replies.push(payload); },
    });
    const embed = replies[0].embeds[0].toJSON();

    assert.equal(embed.color, COLORS.warning);
    assert.ok(embed.title.includes(language.flag));
    assert.ok(embed.title.includes(language.label));
    assert.equal(embed.description, t('dialogue.setup.language.noChannel', language.code));
    assert.equal(embed.author, undefined);
    assert.equal(embed.footer, undefined);
  }
});

test('first-pin outcome reports cleanup without claiming that an old pin was kept', () => {
  const text = welcomeOutcomeText({
    pinned: false,
    persisted: false,
    hadOwnedWelcomePin: false,
    cleanupAttempted: true,
    cleanupComplete: true,
    cleanupDeleted: 8,
  }, 'vi');

  assert.match(text, /8/);
  assert.ok(text.includes(t('dialogue.setup.welcomeCreateFailed', 'vi')));
  assert.equal(text.includes(t('dialogue.setup.welcomeFailed', 'vi')), false);
});

test('a channel set result names the channel in its description and offers the cleanup toggle', () => {
  const welcome = { pinned: true, persisted: true, removedOldCount: 1 };
  const auto = buildAlertEmbed(buildChannelSetResult({
    purpose: 'autoCheck', channelId: '123', cleanupEnabled: false, sharesChannel: true, welcome, lang: 'en',
  })).toJSON();

  // A title would print the mention as raw text.
  assert.doesNotMatch(auto.title, /<#/);
  assert.match(auto.description, /^📍 <#123>\n/);
  assert.match(auto.description, /notification channel/);
  assert.deepEqual(auto.fields.map((field) => field.value), [
    'Pinned · replaced 1 old pin(s)',
    'Off',
    '`/la-setup config action:cleanup-on`',
  ]);
  assert.ok(auto.footer.text.length > 0);

  const notify = buildAlertEmbed(buildChannelSetResult({
    purpose: 'notification', channelId: '456', cleanupEnabled: true, sharesChannel: false, welcome, lang: 'en',
  })).toJSON();
  assert.equal(notify.fields[2].value, '`/la-setup config action:notify-cleanup-off`');
  assert.doesNotMatch(notify.description, /⚠️/);
});

test('a notice whose first line names a channel keeps that line out of the title', () => {
  const embed = buildNoticeEmbed(
    '✅ Cleared **3** unpinned messages in <#123> and rebuilt the welcome guide.',
    { severity: AlertSeverity.SUCCESS },
  ).toJSON();

  assert.equal(embed.title, undefined);
  assert.match(embed.description, /in <#123> and/);
});
