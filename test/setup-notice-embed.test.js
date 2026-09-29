import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import GuildConfig from '../bot/models/GuildConfig.js';
import { disconnectDB } from '../bot/db.js';
import { getSupportedLanguages, t } from '../bot/services/i18n/index.js';
import { COLORS } from '../bot/utils/ui.js';
import { SETUP_ACTION_HANDLERS, welcomeOutcomeText } from '../bot/handlers/setup/guildSetup.js';

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
