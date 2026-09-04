import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

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

function attachmentsOf(...attachments) {
  return new Collection(attachments.map((attachment, index) => [
    attachment.id || `attachment-${index + 1}`,
    attachment,
  ]));
}

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
  assert.deepEqual(parseAutoCheckText('check abcxyz defuvw'), {
    names: ['Abcxyz', 'Defuvw'],
    invalidTokens: [],
  });
  assert.deepEqual(parseAutoCheckText('check abcxyz, defuvw'), {
    names: ['Abcxyz', 'Defuvw'],
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

test('auto-check Quick Add requires a verified identity with no list hit', () => {
  assert.equal(isQuickAddCandidate({
    identityVerified: true,
    blackEntry: null,
    whiteEntry: null,
    watchEntry: null,
    trustedEntry: null,
  }), true);

  assert.equal(isQuickAddCandidate({
    identityVerified: false,
    blackEntry: null,
    whiteEntry: null,
    watchEntry: null,
    trustedEntry: null,
  }), false);

  assert.equal(isQuickAddCandidate({
    identityVerified: true,
    blackEntry: null,
    whiteEntry: null,
    watchEntry: null,
    trustedEntry: { name: 'Clauseduk' },
  }), false);
});

test('auto-check hides unresolved text candidates instead of rendering or Quick Adding them', async () => {
  resetAutoCheckDedupeForTest();
  const edits = [];
  const reactions = [];
  let formatterCalled = false;
  let cardBuilderCalled = false;
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: false,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    checkNamesAgainstListsFn: async (names) => names.map((name) => ({ name })),
    formatCheckResultsFn: () => {
      formatterCalled = true;
      return ['must-not-render'];
    },
    buildListCheckEmbedFn: () => {
      cardBuilderCalled = true;
      return { embed: { title: 'must-not-render' } };
    },
    buildAutoCheckEvidenceRowFn: () => null,
  });
  const message = {
    id: 'unverified-text-message',
    content: 'check ocrnoise',
    channelId: 'channel-1',
    guild: { id: 'guild-1' },
    author: { id: 'unverified-user', bot: false, tag: 'User#0003' },
    attachments: attachmentsOf(),
    channel: { name: 'loa-check' },
    reactions: { cache: { get: () => null } },
    react: async (emoji) => reactions.push(emoji),
    reply: async () => ({
      edit: async (payload) => edits.push(payload),
    }),
  };

  await handler(message);

  assert.equal(formatterCalled, false);
  assert.equal(cardBuilderCalled, false);
  assert.equal(edits.length, 1);
  assert.match(edits[0].embeds[0].toJSON().description, /none matched lostark\.bible/u);
  assert.deepEqual(edits[0].components, []);
  assert.deepEqual(reactions, ['🔍', '⚠️']);
});

test('auto-check message handler sends prefixed text through the shared list-check card', async () => {
  resetAutoCheckDedupeForTest();
  const checked = [];
  const edits = [];
  const reactions = [];
  const languageGuilds = [];
  const renderedLangs = [];
  const inputSources = [];
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: false,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async (guildId) => {
      languageGuilds.push(guildId);
      return 'vi';
    },
    checkNamesAgainstListsFn: async (names, options) => {
      checked.push(names);
      inputSources.push(options.inputSource);
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
    attachments: attachmentsOf(),
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
  assert.deepEqual(inputSources, ['text']);
});

test('auto-check message handler keeps image OCR as the priority over a text caption', async () => {
  resetAutoCheckDedupeForTest();
  const checked = [];
  const replies = [];
  const edits = [];
  const inputSources = [];
  let extracted = 0;
  let extractionOptions = null;
  const image = { id: 'image-1', contentType: 'image/png' };
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: true,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    extractNamesFromImageFn: async (input, options) => {
      extracted += 1;
      assert.equal(input, image);
      assert.equal(replies.length, 1, 'status card must exist before OCR starts');
      assert.match(replies[0].embeds[0].toJSON().title, /reading 1\/1/i);
      extractionOptions = options;
      return ['FromImage'];
    },
    checkNamesAgainstListsFn: async (names, options) => {
      checked.push(names);
      inputSources.push(options.inputSource);
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
    attachments: attachmentsOf(image),
    channel: { name: 'loa-check' },
    reactions: { cache: { get: () => null } },
    react: async () => {},
    reply: async (payload) => {
      replies.push(payload);
      return { edit: async (editPayload) => edits.push(editPayload) };
    },
  };

  await handler(message);

  assert.equal(extracted, 1);
  assert.equal(extractionOptions?.refineAmbiguousDiacritics, true);
  assert.ok(extractionOptions?.suggestionCache instanceof Map);
  assert.equal(extractionOptions?.suggestionContext?.cache, extractionOptions?.suggestionCache);
  assert.deepEqual(checked, [['FromImage']]);
  assert.deepEqual(inputSources, ['ocr']);
  assert.equal(replies.length, 1);
  assert.equal(edits.at(-1).embeds[0].title, 'image-check');
});

test('auto-check reads up to three attached images sequentially and deduplicates their names', async () => {
  resetAutoCheckDedupeForTest();
  const images = [1, 2, 3, 4].map((number) => ({
    id: `batch-image-${number}`,
    contentType: 'image/png',
  }));
  const extractedOrder = [];
  const replies = [];
  const edits = [];
  const checked = [];
  let activeExtractions = 0;
  let maxActiveExtractions = 0;
  const namesByImage = new Map([
    ['batch-image-1', ['Alpha', 'Shared']],
    ['batch-image-2', ['shared', 'Beta']],
    ['batch-image-3', ['Gamma']],
  ]);
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: true,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    extractNamesFromImageFn: async (image) => {
      extractedOrder.push(image.id);
      activeExtractions += 1;
      maxActiveExtractions = Math.max(maxActiveExtractions, activeExtractions);
      await new Promise((resolve) => setImmediate(resolve));
      activeExtractions -= 1;
      return namesByImage.get(image.id) || [];
    },
    checkNamesAgainstListsFn: async (names) => {
      checked.push(names);
      return names.map((name) => ({ name, blackEntry: { name } }));
    },
    formatCheckResultsFn: () => ['formatted'],
    buildListCheckEmbedFn: () => ({ embed: { title: 'batch-check' } }),
    buildAutoCheckEvidenceRowFn: () => null,
  });
  const message = {
    id: 'batch-image-message',
    content: '',
    channelId: 'channel-1',
    guild: { id: 'guild-1' },
    author: { id: 'batch-user', bot: false, tag: 'BatchUser#0001' },
    attachments: attachmentsOf(...images),
    channel: { name: 'loa-check' },
    reactions: { cache: { get: () => null } },
    react: async () => {},
    reply: async (payload) => {
      replies.push(payload);
      return { edit: async (editPayload) => edits.push(editPayload) };
    },
  };

  await handler(message);

  assert.deepEqual(extractedOrder, ['batch-image-1', 'batch-image-2', 'batch-image-3']);
  assert.equal(maxActiveExtractions, 1);
  assert.deepEqual(checked, [['Alpha', 'Shared', 'Beta', 'Gamma']]);
  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].toJSON().title, /reading 1\/3/i);
  assert.match(replies[0].embeds[0].toJSON().description, /skipped \*\*1\*\* extra/i);
  assert.equal(edits.at(-1).embeds[0].title, 'batch-check');
});

test('auto-check queues rapid image messages instead of dropping them to cooldown', async () => {
  resetAutoCheckDedupeForTest();
  let releaseFirstExtraction;
  let markFirstExtractionStarted;
  const firstExtractionGate = new Promise((resolve) => {
    releaseFirstExtraction = resolve;
  });
  const firstExtractionStarted = new Promise((resolve) => {
    markFirstExtractionStarted = resolve;
  });
  const extractedOrder = [];
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: true,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    extractNamesFromImageFn: async (image) => {
      extractedOrder.push(image.id);
      if (image.id === 'queued-image-1') {
        markFirstExtractionStarted();
        await firstExtractionGate;
      }
      return [image.id === 'queued-image-1' ? 'First' : 'Second'];
    },
    checkNamesAgainstListsFn: async (names) => names.map((name) => ({
      name,
      blackEntry: { name },
    })),
    formatCheckResultsFn: () => ['formatted'],
    buildListCheckEmbedFn: ({ results }) => ({ embed: { title: results[0].name } }),
    buildAutoCheckEvidenceRowFn: () => null,
  });

  function createQueuedMessage(number) {
    const replies = [];
    const edits = [];
    return {
      replies,
      edits,
      message: {
        id: `queued-message-${number}`,
        content: '',
        channelId: 'channel-1',
        guild: { id: 'guild-1' },
        author: { id: 'same-user', bot: false, tag: 'QueueUser#0001' },
        attachments: attachmentsOf({
          id: `queued-image-${number}`,
          contentType: 'image/png',
        }),
        channel: { name: 'loa-check' },
        reactions: { cache: { get: () => null } },
        react: async () => {},
        reply: async (payload) => {
          replies.push(payload);
          return { edit: async (editPayload) => edits.push(editPayload) };
        },
      },
    };
  }

  const first = createQueuedMessage(1);
  const second = createQueuedMessage(2);
  const firstRun = handler(first.message);
  await firstExtractionStarted;
  const secondRun = handler(second.message);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(extractedOrder, ['queued-image-1']);
  assert.equal(second.replies.length, 1);
  assert.match(second.replies[0].embeds[0].toJSON().title, /queued/i);
  assert.match(second.replies[0].embeds[0].toJSON().title, /1 image request/i);

  releaseFirstExtraction();
  await Promise.all([firstRun, secondRun]);

  assert.deepEqual(extractedOrder, ['queued-image-1', 'queued-image-2']);
  assert.equal(first.edits.at(-1).embeds[0].title, 'First');
  assert.equal(second.edits.at(-1).embeds[0].title, 'Second');
});

test('auto-check replaces the live status card when image processing fails', async () => {
  resetAutoCheckDedupeForTest();
  const replies = [];
  const edits = [];
  const reactions = [];
  const handler = createAutoCheckMessageHandler({
    client: { user: { id: 'bot-user' } },
    imageChecksEnabled: true,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'en',
    extractNamesFromImageFn: async () => {
      assert.equal(replies.length, 1);
      throw new Error('OCR timed out');
    },
    buildAutoCheckEvidenceRowFn: () => null,
  });
  const message = {
    id: 'failed-image-message',
    content: '',
    channelId: 'channel-1',
    guild: { id: 'guild-1' },
    author: { id: 'failed-image-user', bot: false, tag: 'FailedUser#0001' },
    attachments: attachmentsOf({ id: 'failed-image', contentType: 'image/png' }),
    channel: { name: 'loa-check' },
    reactions: { cache: { get: () => null } },
    react: async (emoji) => reactions.push(emoji),
    reply: async (payload) => {
      replies.push(payload);
      return { edit: async (editPayload) => edits.push(editPayload) };
    },
  };

  await handler(message);

  assert.equal(replies.length, 1, 'failure must reuse the existing status reply');
  assert.equal(edits.length, 1);
  assert.match(edits[0].embeds[0].toJSON().title, /could not finish/i);
  assert.deepEqual(reactions, ['🔍', '❌']);
});
