import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const { createAutoCheckMessageHandler, parseAutoRosterText, resetAutoCheckDedupeForTest } =
  await import('../bot/handlers/list/auto-check.js');
const { runRosterLookup } = await import('../bot/handlers/roster/command.js');
const { handleHiddenRosterResult } = await import('../bot/handlers/roster/hiddenRoster.js');
const { bibleClient } = await import('../bot/services/roster/bibleClient.js');
const { clearNameSuggestionCache } = await import('../bot/services/roster/search.js');
const { disconnectDB } = await import('../bot/db.js');
const { t } = await import('../bot/services/i18n/index.js');

function fixture({ content = 'roster Alpha', active = true, lookup, lang = 'en' } = {}) {
  resetAutoCheckDedupeForTest();
  const events = [];
  const message = {
    id: 'roster-message', content, channelId: 'channel', guild: { id: 'guild' },
    author: { id: 'sender', bot: false }, attachments: new Collection(),
    react: async emoji => events.push(['reaction', emoji]),
    reply: async payload => {
      events.push(['reply', payload]);
      return { edit: async payload => events.push(['edit', payload]) };
    },
  };
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot' } }, imageChecksEnabled: false,
    isAutoCheckChannelFn: async () => active,
    getGuildLanguageFn: async () => lang,
    getUserOcrModeFn: () => assert.fail('roster must not load OCR preferences'),
    extractNamesFromImageFn: () => assert.fail('roster must not use OCR'),
    checkNamesAgainstListsFn: () => assert.fail('roster must use the shared roster flow'),
    runRosterLookupFn: lookup || (async args => {
      events.push(['lookup', args]);
      await args.replyEditor.edit({ embeds: [{ title: 'Roster' }] });
      return true;
    }),
  });
  return { message, handler, events };
}

test('roster parser accepts one typed Unicode name and ignores ordinary chatter', () => {
  for (const content of ['roster Défüvw', ' ROSTER: défüvw ', 'roster\nDéfüvw']) {
    assert.deepEqual(parseAutoRosterText(content), { name: 'Défüvw' });
  }
  for (const content of ['Alpha', 'rosters Alpha', 'please roster Alpha', 'rosterify', 'check Alpha']) {
    assert.equal(parseAutoRosterText(content), null);
  }
});

test('roster rejects missing names, invalid names and every multi-name separator before normalization', () => {
  for (const content of ['roster', 'roster:', 'roster Alpha Beta', 'roster Alpha Alpha',
    'roster Alpha,Beta', 'roster Alpha;Beta', 'roster Alpha\nBeta', 'roster Alpha\tBeta',
    'roster <@123>', 'roster https://lostark.bible/character/NA/Alpha', 'roster A']) {
    assert.deepEqual(parseAutoRosterText(content), { name: null }, content);
  }
});

test('channel roster acknowledges before lookup, uses guild locale/scope, and runs without OCR', async () => {
  const f = fixture({ lang: 'vi' });
  // An explicit roster request takes precedence over attached images.
  f.message.attachments.set('image', { contentType: 'image/png' });
  await f.handler(f.message);
  assert.deepEqual(f.events.map(([kind]) => kind), ['reply', 'lookup', 'edit', 'reaction']);
  const args = f.events[1][1];
  assert.equal(args.name, 'Alpha');
  assert.equal(args.lang, 'vi');
  assert.equal(args.guildId, 'guild');
  assert.equal(args.deep, undefined);
  assert.match(f.events[0][1].embeds[0].data.title, /Tớ đang tra roster của Alpha/);
  assert.equal(f.events.at(-1)[1], '✅');
});

test('invalid roster request gives localized usage without lookup', async () => {
  for (const lang of ['en', 'vi', 'jp']) {
    const f = fixture({ content: 'roster Alpha Beta', lang, lookup: () => assert.fail('invalid input') });
    await f.handler(f.message);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0][1].embeds[0].data.description, t('dialogue.roster.text.invalid', lang).description);
  }
});

test('roster obeys channel, guild and bot gates', async () => {
  for (const gate of ['channel', 'guild', 'bot']) {
    const f = fixture({ active: gate !== 'channel', lookup: () => assert.fail(gate) });
    if (gate === 'guild') f.message.guild = null;
    if (gate === 'bot') f.message.author.bot = true;
    await f.handler(f.message);
    assert.deepEqual(f.events, []);
  }
});

test('roster deduplicates in-flight messages and shares the text cooldown', async () => {
  let finish, enter;
  const started = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  let lookups = 0;
  const f = fixture({ lookup: async () => { lookups++; enter(); await held; return true; } });
  const first = f.handler(f.message);
  await started;
  try {
    await f.handler(f.message);
    await f.handler({ ...f.message, id: 'another-message', content: 'check Beta' });
    assert.equal(lookups, 1);
    assert.equal(f.events.length, 1);
  } finally { finish(); await first; }
  await f.handler(f.message);
  assert.equal(lookups, 1);
});

test('roster lookup warnings are not labelled successful by the channel handler', async () => {
  const f = fixture({ lookup: async ({ replyEditor }) => {
    await replyEditor.edit({ embeds: [{ title: 'Unavailable' }] });
    return false;
  } });
  await f.handler(f.message);
  assert.equal(f.events.at(-1)[1], '⚠️');
});

test('shared roster flow routes visible and hidden results with the same scope and locale', async () => {
  for (const characters of [[], [{ name: 'Alpha', itemLevel: 1700 }]]) {
    const calls = [];
    const render = async args => calls.push(args);
    assert.equal(await runRosterLookup({
      name: 'Alpha', guildId: 'guild', lang: 'jp', replyEditor: {},
    }, {
      fetchRoster: async (name, deep) => {
        assert.equal(name, 'Alpha'); assert.equal(deep, false);
        return { characters, world: 'Balthorr' };
      },
      renderVisible: characters.length ? render : () => assert.fail('visible'),
      renderHidden: characters.length ? () => assert.fail('hidden') : render,
    }), true);
    assert.equal(calls[0].guildId, 'guild');
    assert.equal(calls[0].lang, 'jp');
    assert.equal(calls[0].world, 'Balthorr');
    assert.equal(calls[0].deep, false);
  }
});

test('shared roster flow preserves fetch and list failure notices', async () => {
  for (const stage of ['fetch', 'list-check']) {
    const edits = [];
    const fail = () => { throw Object.assign(new Error('unavailable'), { rosterStage: stage }); };
    assert.equal(await runRosterLookup({
      name: 'Alpha', guildId: 'guild', lang: 'vi',
      replyEditor: { edit: async payload => edits.push(payload) },
    }, {
      fetchRoster: stage === 'fetch' ? fail : async () => ({ characters: [{}] }),
      renderVisible: fail,
    }), false);
    const key = stage === 'fetch' ? 'fetchFailed' : 'listCheckFailed';
    assert.equal(edits[0].embeds[0].data.description, t(`dialogue.roster.${key}`, 'vi').description);
  }
});

test('a name Bible has no profile for is labelled a warning, not a success', async () => {
  const f = fixture({ lookup: args => runRosterLookup(args, {
    fetchRoster: async () => ({ characters: [] }),
    renderHidden: async ({ replyEditor }) => {
      await replyEditor.edit({ embeds: [{ title: 'No roster found' }] });
      return false;
    },
  }) });
  await f.handler(f.message);
  assert.deepEqual(f.events.map(([kind]) => kind), ['reply', 'edit', 'reaction']);
  assert.equal(f.events.at(-1)[1], '⚠️');
});

test('hidden roster flow returns false when Bible has no profile for the name', async context => {
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(bibleClient, 'fetch', async url => String(url).includes('/_app/remote/ngsbie/search')
    ? { ok: true, status: 200, json: async () => ({ type: 'result', data: [[]] }) }
    : { ok: false, status: 404 });
  clearNameSuggestionCache();
  context.after(async () => { clearNameSuggestionCache(); await disconnectDB(); });
  const edits = [];
  const rendered = await handleHiddenRosterResult({
    guildId: 'guild', lang: 'en', name: 'Nobodyhere',
    replyEditor: { edit: async payload => edits.push(payload) },
  });
  assert.equal(rendered, false);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].embeds[0].toJSON().description,
    t('dialogue.listAdd.noRoster.withoutSuggestions', 'en', { name: 'Nobodyhere' }));
});

test('the text cooldown expires after its 10 second window', async context => {
  let now = 1_000;
  context.mock.method(performance, 'now', () => now);
  const f = fixture();
  const send = id => f.handler({ ...f.message, id });
  const lookups = () => f.events.filter(([kind]) => kind === 'lookup').length;
  await send('first');
  assert.equal(lookups(), 1);
  now += 9_999;
  await send('inside-window');
  assert.equal(lookups(), 1);
  now += 1;
  await send('after-window');
  assert.equal(lookups(), 2);
});
