import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../bot/config.js';
import { t } from '../bot/services/i18n/index.js';
import { LIST_FORM_IDS } from '../bot/handlers/list/form/fields.js';
import { refuseCoolingDown, resetCommandCooldowns } from '../bot/app/commandCooldowns.js';

function command(name, { subcommand = null, userId = 'member-1' } = {}) {
  const replies = [];
  return {
    replies,
    commandName: name,
    user: { id: userId },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    options: { getSubcommand: () => subcommand },
    reply: async (payload) => { replies.push(payload); },
  };
}

function modal(customId, userId = 'member-1') {
  const replies = [];
  return {
    replies,
    customId,
    user: { id: userId },
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    reply: async (payload) => { replies.push(payload); },
  };
}

const getLang = async () => 'en';

test('a second /la-check inside its cooldown is refused privately; another member is not', async (t2) => {
  resetCommandCooldowns();
  t2.after(() => resetCommandCooldowns());
  assert.equal(await refuseCoolingDown(command('la-check'), { getLang }), false);
  const again = command('la-check');
  assert.equal(await refuseCoolingDown(again, { getLang }), true);
  assert.ok(again.replies[0].embeds[0].toJSON().title.endsWith(t('dialogue.common.cooldown', 'en').title));
  assert.equal(await refuseCoolingDown(command('la-check', { userId: 'member-2' }), { getLang }), false);
});

test('the cooldown frees up when its time passes', async (t2) => {
  let now = 0;
  resetCommandCooldowns({ now: () => now });
  t2.after(() => resetCommandCooldowns());
  assert.equal(await refuseCoolingDown(command('la-roster'), { getLang }), false);
  now = 5001;
  assert.equal(await refuseCoolingDown(command('la-roster'), { getLang }), false);
});

test('list writes share one cooldown across the command and its forms', async (t2) => {
  resetCommandCooldowns();
  t2.after(() => resetCommandCooldowns());
  assert.equal(await refuseCoolingDown(command('la-list', { subcommand: 'add' }), { getLang }), false);
  assert.equal(await refuseCoolingDown(modal(LIST_FORM_IDS.addModal), { getLang }), true);
  assert.equal(await refuseCoolingDown(modal(LIST_FORM_IDS.editModal), { getLang }), true);
  assert.equal(await refuseCoolingDown(command('la-list', { subcommand: 'view' }), { getLang }), false, 'reads are not limited');
});

test('officers and seniors, and commands without a cost, are never refused', async (t2) => {
  resetCommandCooldowns();
  t2.after(() => resetCommandCooldowns());
  const officers = config.officerApproverIds;
  config.officerApproverIds = ['officer-1'];
  t2.after(() => { config.officerApproverIds = officers; });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await refuseCoolingDown(command('la-check', { userId: 'officer-1' }), { getLang }), false);
    assert.equal(await refuseCoolingDown(command('la-help'), { getLang }), false);
  }
});

function multiadd(action, userId = 'member-1') {
  const interaction = command('la-list', { subcommand: 'multiadd', userId });
  interaction.options.getString = (name) => (name === 'action' ? action : null);
  return interaction;
}

test('a multiadd file upload waits out its cooldown; the template download never does', async (t2) => {
  resetCommandCooldowns();
  t2.after(() => resetCommandCooldowns());
  assert.equal(await refuseCoolingDown(multiadd('template'), { getLang }), false);
  assert.equal(await refuseCoolingDown(multiadd('file'), { getLang }), false);
  assert.equal(await refuseCoolingDown(multiadd('template'), { getLang }), false);
  assert.equal(await refuseCoolingDown(multiadd('file'), { getLang }), true);
  assert.equal(await refuseCoolingDown(multiadd('file', 'member-2'), { getLang }), false);
});

test('a modal id that names an object property is not limited and does not throw', async (t2) => {
  resetCommandCooldowns();
  t2.after(() => resetCommandCooldowns());
  for (const customId of ['constructor:1', '__proto__:x', 'toString', 'hasOwnProperty']) {
    assert.equal(await refuseCoolingDown(modal(customId), { getLang }), false, customId);
  }
});
