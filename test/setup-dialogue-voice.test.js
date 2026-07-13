import test from 'node:test';
import assert from 'node:assert/strict';

import { TRANSLATIONS } from '../bot/locales/index.js';

// Setup notices use first-person localized copy without narrating the tool as
// "LoaLogs" in the third person. They also reference the consolidated command
// surface rather than the removed `/la-setup <subcommand>` forms.
const LANGS = ['en', 'vi', 'jp'];
const DEAD_SUBCOMMAND = /\/la-setup (autochannel|notifychannel|cleanup state|defaultscope|off|repin|view|language)\b/;

for (const lang of LANGS) {
  test(`${lang}: setup notices use the config action syntax, not dead subcommands`, () => {
    const blob = JSON.stringify(TRANSLATIONS[lang].dialogue.setup);
    assert.doesNotMatch(blob, DEAD_SUBCOMMAND);
  });

  test(`${lang}: setup notices speak as Artist, not third-person LoaLogs`, () => {
    const setup = JSON.stringify(TRANSLATIONS[lang].dialogue.setup);
    const common = JSON.stringify([
      TRANSLATIONS[lang].dialogue.common.wrongTextChannel,
      TRANSLATIONS[lang].dialogue.common.missingPermissions,
    ]);
    assert.doesNotMatch(setup, /LoaLogs/);
    assert.doesNotMatch(common, /LoaLogs/);
  });
}
