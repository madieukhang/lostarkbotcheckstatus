import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { resolveRemoveResultPresentation } = await import(
  '../bot/handlers/list/remove/index.js'
);

const success = (type, icon, label) => ({ ok: true, type, icon, label });
const failure = { ok: false, reason: 'not-owner' };

test('remove result presentation follows the ordered outcome table', () => {
  const blocked = resolveRemoveResultPresentation({
    oks: [],
    fails: [failure],
    name: 'Alpha',
    lang: 'en',
  });
  const single = resolveRemoveResultPresentation({
    oks: [success('black', '⛔', 'Blacklist')],
    fails: [],
    name: 'Alpha',
    lang: 'en',
  });
  const many = resolveRemoveResultPresentation({
    oks: [success('black', '⛔', 'Blacklist'), success('white', '✅', 'Whitelist')],
    fails: [],
    name: 'Alpha',
    lang: 'en',
  });
  const mixed = resolveRemoveResultPresentation({
    oks: [success('watch', '👀', 'Watchlist')],
    fails: [failure],
    name: 'Alpha',
    lang: 'en',
  });

  assert.deepEqual(
    [blocked.titleIcon, single.titleIcon, many.titleIcon, mixed.titleIcon],
    ['⚠️', '⛔', '🗑️', '⚠️']
  );
  assert.deepEqual(
    [blocked.color, single.color, many.color, mixed.color],
    [0xfee75c, 0xed4245, 0x57f287, 0xfee75c]
  );
});
