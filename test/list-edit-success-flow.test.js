import test from 'node:test';
import assert from 'node:assert/strict';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import { CLASS_EMOJI_MAP } from '../bot/models/Class.js';
import { applyListEditNow } from '../bot/handlers/list/edit/applyNow.js';
import { buildListEditPlan } from '../bot/handlers/list/edit/plan.js';

for (const isMove of [false, true]) {
  test(`edit reply refreshes both archived images and loads the roster stats (${isMove ? 'move' : 'in-place'})`, async t => {
    const existing = {
      _id: 'a'.repeat(24), name: 'Tenshi', reason: 'Reason', allCharacters: [],
      imageUrl: '', imageMessageId: 'old-image', imageChannelId: 'archive',
      addedByUserId: 'owner',
    };
    const currentType = isMove ? 'white' : 'black';
    // A move reloads the source inside its transaction. The before preview
    // must come from that source, even if the command's first read was stale.
    const source = { ...existing, imageMessageId: isMove ? 'latest-old-image' : 'old-image' };
    let persisted;
    if (isMove) {
      t.mock.method(Blacklist, 'findOne', () => ({ collation() { return this; }, lean: async () => null }));
      t.mock.method(Whitelist.db, 'transaction', async run => run('session'));
      t.mock.method(Whitelist, 'findById', () => ({ session: async () => source }));
      t.mock.method(Blacklist, 'create', async ([entry]) => { persisted = entry; return [entry]; });
      t.mock.method(Whitelist, 'deleteOne', async () => ({ deletedCount: 1 }));
    } else {
      t.mock.method(Blacklist, 'updateOne', async (_filter, update) => {
        persisted = { ...source, ...update.$set };
      });
    }
    t.mock.method(RosterSnapshot, 'find', (filter, projection) => {
      assert.deepEqual(filter, { name: { $in: ['Tenshi'] } });
      assert.deepEqual(projection, { _id: 0, name: 1, classId: 1, itemLevel: 1, combatScore: 1, world: 1 });
      return {
        collation(value) { assert.deepEqual(value, { locale: 'en', strength: 2 }); return this; },
        lean: async () => [{ name: 'Tenshi', classId: 'bard' }],
      };
    });
    const previousEmoji = CLASS_EMOJI_MAP.Bard;
    CLASS_EMOJI_MAP.Bard = '<:bard:123456789012345678>';
    t.after(() => { CLASS_EMOJI_MAP.Bard = previousEmoji; });
    const fetched = [];
    const client = { channels: { fetch: async channelId => {
      assert.equal(channelId, 'archive');
      return { isTextBased: () => true, messages: { fetch: async messageId => {
        fetched.push(messageId);
        return { attachments: { first: () => ({ url: `https://example.test/${messageId}.png` }) } };
      } } };
    } } };
    const replies = [];
    const plan = buildListEditPlan({
      existing, currentType, newType: 'black',
      newImageUrl: 'https://example.test/upload.png', lang: 'vi',
    });
    await applyListEditNow({
      ...plan, existing, currentType, client,
      interaction: { user: { id: 'owner', username: 'Owner' }, editReply: async reply => replies.push(reply) },
      newImageUrl: 'https://example.test/upload.png',
      newImageRehost: { messageId: 'new-image', channelId: 'archive' },
      editGuildId: 'guild', editGuildDefaultScope: 'global', isOwner: true, lang: 'vi',
    });

    assert.equal(replies.length, 1);
    const cards = replies[0].embeds.map(embed => embed.toJSON());
    assert.equal(cards.length, 2);
    assert.match(cards[0].title, isMove ? /Đã sửa và chuyển list/ : /Đã chỉnh sửa/);
    assert.equal(cards[0].image.url, `https://example.test/${source.imageMessageId}.png`);
    assert.equal(cards[1].image.url, 'https://example.test/new-image.png');
    assert.match(cards[0].fields[0].value, /^<:bard:123456789012345678> \[Tenshi\]/);
    assert.deepEqual(fetched.sort(), [source.imageMessageId, 'new-image'].sort());
    assert.equal(persisted.imageMessageId, 'new-image');
    assert.equal(persisted.imageChannelId, 'archive');
    assert.equal(persisted.imageUrl, '');
    assert.equal(existing.imageMessageId, 'old-image');
    assert.ok(cards.every(card => card.footer === undefined));
  });
}

test('roster stat lookup failure does not turn a saved edit into an error or duplicate unchanged evidence', async t => {
  const existing = { _id: 'a'.repeat(24), name: 'Tenshi', reason: 'Old', imageUrl: 'https://example.test/current.png' };
  let saved = false;
  t.mock.method(Blacklist, 'updateOne', async () => { saved = true; });
  t.mock.method(RosterSnapshot, 'find', () => { throw new Error('Snapshot unavailable'); });
  t.mock.method(console, 'warn', () => {});
  const replies = [];
  await applyListEditNow({
    existing, currentType: 'black', targetType: 'black', newReason: 'New',
    additionalNamesParsed: { added: [] }, changes: ['Reason changed'], isOwner: true,
    interaction: { user: { id: 'owner', username: 'Owner' }, editReply: async reply => replies.push(reply) }, client: {}, lang: 'vi',
  });
  assert.equal(saved, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].embeds.length, 1);
  const card = replies[0].embeds[0].toJSON();
  assert.match(card.title, /Đã chỉnh sửa/);
  assert.match(card.fields[0].value, /^\[Tenshi\]/);
  assert.equal(card.image.url, existing.imageUrl);
  assert.doesNotMatch(JSON.stringify(card), /Trước khi đổi|Sau khi đổi/);
});
