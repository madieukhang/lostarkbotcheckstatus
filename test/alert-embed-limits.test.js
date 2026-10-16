import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { buildAlertEmbed, AlertSeverity } from '../bot/utils/alertEmbed.js';
import { createAutoCheckMessageHandler, resetAutoCheckDedupeForTest } from '../bot/handlers/list/auto-check.js';

// Error cards carry raw error text, which can exceed Discord's embed limits;
// the card must still build instead of throwing from the error path.
test('an alert with text past the embed limits is cut to them instead of throwing', () => {
  const embed = buildAlertEmbed({
    severity: AlertSeverity.ERROR,
    title: 't'.repeat(300),
    description: 'd'.repeat(5000),
    fields: [{ name: 'n'.repeat(300), value: `\`${'v'.repeat(1100)}\`` }],
    footer: 'f'.repeat(2100),
  }).toJSON();

  assert.equal(embed.title.length, 256);
  assert.equal(embed.description.length, 4096);
  assert.equal(embed.fields[0].name.length, 256);
  assert.equal(embed.fields[0].value.length, 1024);
  assert.match(embed.fields[0].value, /^`v+…`$/);
  assert.equal(embed.footer.text.length, 2048);
});

test('an alert within the limits is unchanged', () => {
  const embed = buildAlertEmbed({
    severity: AlertSeverity.WARNING,
    title: 'Short',
    fields: [{ name: 'Error', value: '`boom`' }],
  }).toJSON();

  assert.equal(embed.fields[0].value, '`boom`');
});

test('a text check that fails with a long error ends on the error card, not the progress card', async (t) => {
  resetAutoCheckDedupeForTest();
  t.after(resetAutoCheckDedupeForTest);
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const cards = [];
  const progressMsg = { edit: async (payload) => { cards.push(payload); return progressMsg; } };
  const message = {
    id: 'long-error', content: 'check Gatomanzana',
    author: { id: 'u1', bot: false, tag: 'u1' }, guild: { id: 'g' }, channelId: 'c', channel: { name: 'auto-check' },
    attachments: new Collection(), reactions: { cache: new Collection() },
    react: async () => {},
    reply: async (payload) => { cards.push(payload); return progressMsg; },
  };
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot' } },
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    checkNamesAgainstListsFn: async () => { throw new Error('x'.repeat(1100)); },
  });

  await handler(message);

  assert.match(cards.at(-1).embeds[0].toJSON().title, /could not finish that check/);
});
