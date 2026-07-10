import test from 'node:test';
import assert from 'node:assert/strict';

import { AlertSeverity, buildNoticeEmbed } from '../bot/utils/alertEmbed.js';
import { getSupportedLanguages, t } from '../bot/services/i18n/index.js';
import { COLORS } from '../bot/utils/ui.js';
import { welcomeOutcomeText } from '../bot/handlers/setup/guildSetup.js';

test('/la-setup language renders a localized embed in every supported language', () => {
  for (const language of getSupportedLanguages()) {
    const copy = [
      `🌐 ${t('dialogue.setup.language.set', language.code, {
        flag: language.flag,
        label: language.label,
      })}`,
      t('dialogue.setup.language.noChannel', language.code),
    ].join('\n');
    const embed = buildNoticeEmbed(copy, {
      severity: AlertSeverity.WARNING,
      titleIcon: '🌐',
      lang: language.code,
    }).toJSON();

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
