import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = 'senior-1';

const { handleStatsCommand } = await import('../bot/handlers/meta/stats.js');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');

function createStatsInteraction(userId) {
  const replies = [];
  return {
    replies,
    interaction: {
      user: { id: userId },
      client: { uptime: 60_000, guilds: { cache: { size: 2 } } },
      deferReply: async () => {},
      editReply: async (payload) => {
        replies.push(payload);
        return {};
      },
    },
  };
}

function mockCountModels(t) {
  let counted = 0;
  for (const Model of [Blacklist, Whitelist, Watchlist, GuildConfig]) {
    t.mock.method(Model, 'countDocuments', async () => {
      counted += 1;
      return 1;
    });
  }
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  return () => counted;
}

test('stats refuses non-senior users before any count query', async (t) => {
  const counted = mockCountModels(t);
  const { replies, interaction } = createStatsInteraction('stranger-1');

  await handleStatsCommand(interaction, { connectDBFn: async () => {} });

  assert.equal(counted(), 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].embeds.length, 1);
});

test('stats rolls up the counts for seniors', async (t) => {
  const counted = mockCountModels(t);
  const { replies, interaction } = createStatsInteraction('senior-1');

  await handleStatsCommand(interaction, { connectDBFn: async () => {} });

  assert.equal(counted(), 5);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].embeds.length, 1);
  const card = replies[0].embeds[0].toJSON();
  assert.match(card.title, /statistics|統計|thống kê/i);
});
