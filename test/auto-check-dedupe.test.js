import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const {
  claimAutoCheckMessage,
  completeAutoCheckMessage,
  createAutoCheckMessageHandler,
  isQuickAddCandidate,
  parseAutoCheckText,
  resetAutoCheckDedupeForTest,
} = await import('../bot/handlers/list/auto-check.js');

test('auto-check text parser requires the exact check prefix', () => {
  assert.equal(parseAutoCheckText('abcxyz'), null);
  assert.equal(parseAutoCheckText('checkmate abcxyz'), null);
  assert.equal(parseAutoCheckText('please check abcxyz'), null);
});

test('auto-check text parser accepts check/check: with one or many names', () => {
  assert.deepEqual(parseAutoCheckText('check abcxyz'), {
    names: ['Abcxyz'],
    invalidTokens: [],
  });
  assert.deepEqual(parseAutoCheckText('CHECK: abcxyz, DÉFüvw\nabcxyz'), {
    names: ['Abcxyz', 'Défüvw'],
    invalidTokens: [],
  });
});

test('auto-check text parser rejects URLs, mentions, and empty payloads', () => {
  assert.deepEqual(parseAutoCheckText('check:'), {
    names: [],
    invalidTokens: [],
  });
  assert.deepEqual(parseAutoCheckText('check https://example.com <@123>'), {
    names: [],
    invalidTokens: ['https://example.com', '<@123>'],
  });
});

test('auto-check rejects duplicate in-flight message events', () => {
  resetAutoCheckDedupeForTest();

  assert.equal(claimAutoCheckMessage('message-1', 1000), true);
  assert.equal(claimAutoCheckMessage('message-1', 1001), false);

  completeAutoCheckMessage('message-1', { processed: true, now: 1002 });
});

test('auto-check remembers processed messages for the dedupe TTL', () => {
  resetAutoCheckDedupeForTest();

  assert.equal(claimAutoCheckMessage('message-2', 2000), true);
  completeAutoCheckMessage('message-2', { processed: true, now: 2001 });

  assert.equal(claimAutoCheckMessage('message-2', 3000), false);
  assert.equal(claimAutoCheckMessage('message-2', 2001 + 11 * 60 * 1000), true);

  completeAutoCheckMessage('message-2', { processed: true, now: 2001 + 11 * 60 * 1000 });
});

test('auto-check releases inactive-channel claims without marking processed', () => {
  resetAutoCheckDedupeForTest();

  assert.equal(claimAutoCheckMessage('message-3', 4000), true);
  completeAutoCheckMessage('message-3', { processed: false, now: 4001 });

  assert.equal(claimAutoCheckMessage('message-3', 4002), true);
  completeAutoCheckMessage('message-3', { processed: true, now: 4003 });
});

test('auto-check Quick Add excludes trusted names', () => {
  assert.equal(isQuickAddCandidate({
    blackEntry: null,
    whiteEntry: null,
    watchEntry: null,
    trustedEntry: null,
  }), true);

  assert.equal(isQuickAddCandidate({
    blackEntry: null,
    whiteEntry: null,
    watchEntry: null,
    trustedEntry: { name: 'Clauseduk' },
  }), false);
});

test('auto-check message handler sends prefixed text through the shared list-check card', async () => {
  resetAutoCheckDedupeForTest();
  const checked = [];
  const edits = [];
  const reactions = [];
  const languageGuilds = [];
  const renderedLangs = [];
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: false,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async (guildId) => {
      languageGuilds.push(guildId);
      return 'vi';
    },
    checkNamesAgainstListsFn: async (names) => {
      checked.push(names);
      return names.map((name) => ({ name, blackEntry: { name } }));
    },
    formatCheckResultsFn: () => ['formatted'],
    buildListCheckEmbedFn: (options) => {
      renderedLangs.push(options.lang);
      return { embed: { title: 'text-check' } };
    },
    buildAutoCheckEvidenceRowFn: () => null,
  });
  const message = {
    id: 'text-message-1',
    content: 'check abcxyz, defuvw',
    channelId: 'channel-1',
    guild: { id: 'guild-1' },
    author: { id: 'user-1', bot: false, tag: 'User#0001' },
    attachments: {
      filter: () => ({ size: 0, first: () => null }),
    },
    channel: { name: 'loa-check' },
    reactions: { cache: { get: () => null } },
    react: async (emoji) => reactions.push(emoji),
    reply: async () => ({
      edit: async (payload) => edits.push(payload),
    }),
  };

  await handler(message);

  assert.deepEqual(checked, [['Abcxyz', 'Defuvw']]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].embeds[0].title, 'text-check');
  assert.equal(reactions.length, 2);
  assert.deepEqual(languageGuilds, ['guild-1']);
  assert.deepEqual(renderedLangs, ['vi']);
});

test('auto-check message handler keeps image OCR as the priority over a text caption', async () => {
  resetAutoCheckDedupeForTest();
  const checked = [];
  let extracted = 0;
  const image = { id: 'image-1', contentType: 'image/png' };
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: true,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    extractNamesFromImageFn: async (input) => {
      extracted += 1;
      assert.equal(input, image);
      return ['FromImage'];
    },
    checkNamesAgainstListsFn: async (names) => {
      checked.push(names);
      return names.map((name) => ({ name, blackEntry: { name } }));
    },
    formatCheckResultsFn: () => ['formatted'],
    buildListCheckEmbedFn: () => ({ embed: { title: 'image-check' } }),
    buildAutoCheckEvidenceRowFn: () => null,
  });
  const message = {
    id: 'image-message-1',
    content: 'check CaptionMustNotWin',
    channelId: 'channel-1',
    guild: { id: 'guild-1' },
    author: { id: 'user-2', bot: false, tag: 'User#0002' },
    attachments: {
      filter: () => ({ size: 1, first: () => image }),
    },
    channel: { name: 'loa-check' },
    reactions: { cache: { get: () => null } },
    react: async () => {},
    reply: async () => ({ edit: async () => {} }),
  };

  await handler(message);

  assert.equal(extracted, 1);
  assert.deepEqual(checked, [['FromImage']]);
});
