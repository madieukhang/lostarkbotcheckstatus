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
const { clearMetaCache } = await import('../bot/utils/cache/metaCache.js');
const { clearGuildMembersCache } = await import('../bot/services/roster/guildMembers.js');
const { setUserLanguage, clearUserLanguageCache, t } = await import('../bot/services/i18n/index.js');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: TrustedUser } = await import('../bot/models/TrustedUser.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');

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

function metaDataResponse({ guild = true } = {}) {
  return Response.json({ nodes: [{ data: [
    { header: 1 },
    { rosterLevel: 2, stronghold: 3, guild: guild ? 6 : -1, class: 9, ilvl: 10 },
    300, { level: 4, name: 5 }, 70, 'DeepHome', { name: 7, grade: 8 }, 'DeepGuild', 'Member', 'bard', 1725.55,
  ] }] });
}

// The meta profile answers as given; the guild member pages fail unless a
// response is supplied.
function mockBibleProfile(context, { meta, guild = () => ({ ok: false, status: 503 }) }) {
  clearMetaCache();
  clearGuildMembersCache();
  clearNameSuggestionCache();
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(bibleClient, 'fetch', async url => {
    const target = String(url);
    if (target.includes('/_app/remote/ngsbie/search')) {
      return { ok: true, status: 200, json: async () => ({ type: 'result', data: [[]] }) };
    }
    return target.endsWith('/guild/__data.json') || target.endsWith('/guild') ? guild() : meta();
  });
  context.after(async () => {
    clearMetaCache();
    clearGuildMembersCache();
    clearNameSuggestionCache();
    await disconnectDB();
  });
}

function stubListQueries(context) {
  const query = value => ({ collation: () => ({ lean: async () => value }) });
  context.mock.method(Blacklist, 'find', () => query([]));
  context.mock.method(Whitelist, 'find', () => query([]));
  context.mock.method(Whitelist, 'findOne', () => query(null));
  context.mock.method(Watchlist, 'findOne', () => query(null));
  context.mock.method(TrustedUser, 'findOne', () => query(null));
  context.mock.method(RosterSnapshot, 'find', () => query([]));
  context.mock.method(RosterSnapshot, 'bulkWrite', async () => ({}));
}

test('hidden deep scan names a failed guild member fetch instead of reporting a run', async context => {
  mockBibleProfile(context, { meta: () => metaDataResponse() });
  stubListQueries(context);
  const edits = [];
  await handleHiddenRosterResult({
    interaction: { user: { id: 'officer' } }, guildId: 'guild', lang: 'en', name: 'Guilddown', deep: true,
    deepOptions: { useScraperApiForCandidates: false },
    replyEditor: { edit: async payload => edits.push(payload), getMessage: () => null },
  });
  const [primary, notice, ...rest] = edits.at(-1).embeds.map(embed => embed.toJSON());
  assert.deepEqual(rest, []);
  const deepField = primary.fields.find(field => field.name.includes(t('dialogue.roster.deepField', 'en')));
  assert.equal(deepField.value, `\`${t('dialogue.roster.deepNotRun', 'en')}\``);
  assert.equal(notice.description, t('dialogue.enrich.guildUnavailable', 'en', { name: 'Guilddown' }).description);
});

test('hidden deep scan with a failed guild member fetch sends no progress card and shows the guild-unavailable notice', async context => {
  mockBibleProfile(context, { meta: () => metaDataResponse() });
  stubListQueries(context);
  const edits = [];
  await handleHiddenRosterResult({
    interaction: { user: { id: 'officer' } }, guildId: 'guild', lang: 'en', name: 'Guildgone', deep: true,
    deepOptions: { useScraperApiForCandidates: false },
    replyEditor: { edit: async payload => edits.push(payload), getMessage: () => null },
  });
  assert.equal(edits.length, 1, 'only the final card is sent, no progress card before it');
  const progressSubtitle = t('dialogue.scan.guildMembers', 'en', { guild: 'DeepGuild', count: 0 });
  assert.ok(!JSON.stringify(edits[0]).includes(progressSubtitle), progressSubtitle);
  const [, notice, ...rest] = edits[0].embeds.map(embed => embed.toJSON());
  assert.deepEqual(rest, []);
  assert.equal(notice.description, t('dialogue.enrich.guildUnavailable', 'en', { name: 'Guildgone' }).description);
});

test('hidden deep scan on a fetched guild that lists no one still sends the progress card before the final card', async context => {
  mockBibleProfile(context, {
    meta: () => metaDataResponse(),
    guild: () => Response.json({ nodes: [{ data: [{ guild: 1 }, { members: 2 }, []] }] }),
  });
  stubListQueries(context);
  const edits = [];
  await handleHiddenRosterResult({
    interaction: { user: { id: 'officer' } }, guildId: 'guild', lang: 'en', name: 'Guildvacant', deep: true,
    deepOptions: { useScraperApiForCandidates: false },
    replyEditor: { edit: async payload => edits.push(payload), getMessage: () => null },
  });
  assert.equal(edits.length, 2, 'the progress card, then the final card');
  const progressSubtitle = t('dialogue.scan.guildMembers', 'en', { guild: 'DeepGuild', count: 0 });
  assert.ok(JSON.stringify(edits[0]).includes(progressSubtitle), progressSubtitle);
  const [, notice, ...rest] = edits[1].embeds.map(embed => embed.toJSON());
  assert.deepEqual(rest, []);
  assert.equal(notice.description, t('dialogue.roster.deepNotRunNotice', 'en', { name: 'Guildvacant' }).description);
});

async function renderHiddenCard(context, { guild, name }) {
  mockBibleProfile(context, { meta: () => metaDataResponse(), guild });
  stubListQueries(context);
  const edits = [];
  await handleHiddenRosterResult({
    guildId: 'guild', lang: 'en', name,
    replyEditor: { edit: async payload => edits.push(payload), getMessage: () => null },
  });
  return edits.at(-1).embeds[0].toJSON();
}

const membersField = card => card.fields.find(field => field.name.includes(t('dialogue.roster.membersField', 'en')));

test('hidden roster card shows the member count as unknown, not 0, when the guild fetch failed', async context => {
  const card = await renderHiddenCard(context, { name: 'Guilddown' });
  assert.equal(membersField(card).value, `\`${t('dialogue.common.unknown', 'en')}\``);
});

test('hidden roster card shows 0 members for a fetched guild page that lists no one', async context => {
  const card = await renderHiddenCard(context, {
    name: 'Guildempty',
    guild: () => Response.json({ nodes: [{ data: [{ guild: 1 }, { members: 2 }, []] }] }),
  });
  assert.equal(membersField(card).value, '`0`');
});

test('hidden roster flow shows Bible-unavailable, not the suggestions card, when the profile read fails', async context => {
  mockBibleProfile(context, {
    meta: () => ({ ok: false, status: 503, headers: { get: () => '0' } }),
  });
  const edits = [];
  const rendered = await handleHiddenRosterResult({
    guildId: 'guild', lang: 'en', name: 'Bibledown',
    replyEditor: { edit: async payload => edits.push(payload) },
  });
  assert.equal(rendered, false, 'the auto-check reacts with a warning');
  assert.equal(edits.length, 1);
  const card = edits[0].embeds[0].toJSON();
  const unavailable = t('dialogue.search.bibleUnavailable', 'en');
  assert.equal(card.description, unavailable.description);
  assert.ok(card.title.includes(unavailable.title), card.title);
});

test('visible deep scan on a character without a guild shows the no-guild notice', async context => {
  mockBibleProfile(context, { meta: () => metaDataResponse({ guild: false }) });
  stubListQueries(context);
  clearUserLanguageCache();
  await setUserLanguage('officer', 'en');
  context.after(() => clearUserLanguageCache());
  const edits = [];
  const ok = await runRosterLookup({
    interaction: { user: { id: 'officer' }, channelId: 'channel' },
    guildId: 'guild', lang: 'en', name: 'Noguildchar', deep: true,
    deepOptions: { useScraperApiForCandidates: false },
    replyEditor: { edit: async payload => edits.push(payload), getMessage: () => null },
  }, {
    fetchRoster: async () => ({
      characters: [{ name: 'Noguildchar', itemLevel: '1700', combatScore: '1', className: 'Bard', classId: 'bard' }],
      world: '',
    }),
  });
  assert.equal(ok, true);
  const embeds = edits.at(-1).embeds.map(embed => embed.toJSON());
  assert.equal(embeds.length, 2, 'the roster card and the deep scan notice');
  assert.equal(embeds[1].description, t('dialogue.enrich.noGuild', 'en', { name: 'Noguildchar' }).description);
});

test('visible deep scan names a failed guild member fetch instead of reporting a clean scan', async context => {
  mockBibleProfile(context, { meta: () => metaDataResponse() });
  stubListQueries(context);
  clearUserLanguageCache();
  await setUserLanguage('officer', 'en');
  context.after(() => clearUserLanguageCache());
  const edits = [];
  const ok = await runRosterLookup({
    interaction: { user: { id: 'officer' }, channelId: 'channel' },
    guildId: 'guild', lang: 'en', name: 'Visibledown', deep: true,
    deepOptions: { useScraperApiForCandidates: false },
    replyEditor: { edit: async payload => edits.push(payload), getMessage: () => null },
  }, {
    fetchRoster: async () => ({
      characters: [{ name: 'Visibledown', itemLevel: '1700', combatScore: '1', className: 'Bard', classId: 'bard' }],
      world: '',
    }),
  });
  assert.equal(ok, true);
  const embeds = edits.at(-1).embeds.map(embed => embed.toJSON());
  assert.equal(embeds.length, 2, 'the roster card and the deep scan notice');
  assert.equal(embeds[1].description, t('dialogue.enrich.guildUnavailable', 'en', { name: 'Visibledown' }).description);
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
