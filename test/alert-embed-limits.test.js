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

test('an alert at exactly the embed limits is unchanged, and one character more is cut', () => {
  const build = extra => buildAlertEmbed({
    severity: AlertSeverity.WARNING,
    titleIcon: '',
    title: 't'.repeat(256 + extra),
    description: 'd'.repeat(4096 + extra),
    fields: [{ name: 'n'.repeat(256 + extra), value: 'v'.repeat(1024 + extra) }],
    footer: 'f'.repeat(2048 + extra),
  }).toJSON();
  const atLimit = build(0);
  const overLimit = build(1);

  assert.equal(atLimit.title, 't'.repeat(256));
  assert.equal(atLimit.description, 'd'.repeat(4096));
  assert.equal(atLimit.fields[0].name, 'n'.repeat(256));
  assert.equal(atLimit.fields[0].value, 'v'.repeat(1024));
  assert.equal(atLimit.footer.text, 'f'.repeat(2048));
  assert.equal(overLimit.fields[0].value, `${'v'.repeat(1023)}…`);
});

test('a cut never splits an emoji in half', () => {
  const value = buildAlertEmbed({
    severity: AlertSeverity.ERROR,
    fields: [{ name: 'Error', value: `${'a'.repeat(1022)}${'😀'.repeat(10)}` }],
  }).toJSON().fields[0].value;

  assert.ok(value.length <= 1024);
  assert.doesNotMatch(value, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('a field value that is not text still fails like before, so a caller bug stays visible', () => {
  assert.throws(() => buildAlertEmbed({ severity: AlertSeverity.INFO, fields: [{ name: 'Count', value: 5 }] }));
});

// A text `check` message whose list check fails with `failure`; `editFails`
// makes Discord refuse the edit that would show the error card.
async function runFailingTextCheck(t, failure, { editFails = false } = {}) {
  resetAutoCheckDedupeForTest();
  t.after(resetAutoCheckDedupeForTest);
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const cards = [];
  const progressMsg = {
    edit: async (payload) => {
      if (editFails && cards.length > 0) throw new Error('Unknown Message');
      cards.push(payload);
      return progressMsg;
    },
  };
  const message = {
    id: `failing-check-${Math.random()}`, content: 'check Gatomanzana',
    author: { id: 'u1', bot: false, tag: 'u1' }, guild: { id: 'g' }, channelId: 'c', channel: { name: 'auto-check' },
    attachments: new Collection(), reactions: { cache: new Collection() },
    react: async () => {},
    reply: async (payload) => { cards.push(payload); return progressMsg; },
  };
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot' } },
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    checkNamesAgainstListsFn: async () => { throw failure; },
  });
  await handler(message);
  return { lastTitle: cards.at(-1).embeds[0].toJSON().title, warnings };
}

test('a text check that fails with a long error ends on the error card, not the progress card', async (t) => {
  const { lastTitle } = await runFailingTextCheck(t, new Error('x'.repeat(1100)));
  assert.match(lastTitle, /could not finish that check/);
});

test('a text check that fails with a bare value ends on the error card, not the progress card', async (t) => {
  const { lastTitle } = await runFailingTextCheck(t, undefined);
  assert.match(lastTitle, /could not finish that check/);
});

test('an error card Discord refuses to show is logged instead of failing silently', async (t) => {
  const { warnings } = await runFailingTextCheck(t, new Error('boom'), { editFails: true });
  assert.ok(warnings.some(line => /outcome.*Unknown Message/.test(line)), JSON.stringify(warnings));
});
