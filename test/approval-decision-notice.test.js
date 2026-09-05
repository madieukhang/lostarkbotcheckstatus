import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalServices } from '../bot/handlers/list/services/approvals.js';
import { COLORS } from '../bot/utils/ui.js';

const words = {
  en: { duplicate: /matching entry already exists/i, kept: /keep the existing entry/i, failed: /could not complete/i, rejected: /rejected by an officer/i, approved: /was approved/i },
  vi: { duplicate: /trùng với entry đã có/i, kept: /giữ entry hiện tại/i, failed: /chưa thể hoàn tất/i, rejected: /officer từ chối/i, approved: /đã được duyệt/i },
  jp: { duplicate: /既存の entry と重複/, kept: /既存の entry を残す/, failed: /処理を完了できませんでした/, rejected: /officer に却下/, approved: /承認されました/ },
};

function harness(lang, { missingOriginal = false } = {}) {
  const replies = [];
  const sends = [];
  const message = { reply: async value => replies.push(value) };
  const channel = {
    isTextBased: () => true,
    send: async value => sends.push(value),
    messages: { fetch: async () => {
      if (missingOriginal) throw new Error('Unknown Message');
      return message;
    } },
  };
  const service = createApprovalServices({
    client: { guilds: { fetch: async () => ({ id: 'guild', channels: { fetch: async () => channel } }) } },
    getGuildLanguageFn: async () => lang,
    getUserLanguageFn: async () => assert.fail('Origin-channel notices use the guild language'),
  });
  const payload = {
    guildId: 'guild', channelId: 'channel', requestMessageId: 'request',
    requestedByUserId: 'requester', action: 'add', name: 'Samplechar',
    reason: 'Private report content must not become a rejection reason',
  };
  return { service, payload, replies, sends };
}

function textOf(notice) {
  const embed = notice.embeds[0].toJSON();
  return `${embed.title || ''}\n${embed.description || ''}`;
}

for (const lang of Object.keys(words)) {
  for (const state of ['duplicate', 'rejected', 'failed', 'approved']) {
    test(`${lang} requester notice distinguishes ${state} and replies on the original request`, async () => {
      const h = harness(lang);
      const result = state === 'duplicate' ? { ok: false, isDuplicate: true }
        : state === 'failed' ? { ok: false } : { ok: true };
      await h.service.notifyRequesterAboutDecision(h.payload, result, state === 'duplicate' || state === 'rejected');
      assert.equal(h.sends.length, 0);
      assert.equal(h.replies.length, 1);
      const notice = h.replies[0];
      const text = textOf(notice);
      assert.match(text, words[lang][state]);
      if (state === 'duplicate') assert.match(text, words[lang].kept);
      if (state !== 'approved') assert.doesNotMatch(text, words[lang].approved);
      assert.doesNotMatch(text, /dialogue\.approval|Private report content/);
      assert.match(text, /Samplechar/);
      assert.deepEqual(notice.allowedMentions, { users: ['requester'] });
      assert.equal(notice.content, '<@requester>');
      assert.deepEqual(notice.components, []);
      const color = state === 'approved' ? COLORS.success : state === 'rejected' ? COLORS.danger : COLORS.warning;
      assert.equal(notice.embeds[0].toJSON().color, color);
    });
  }
}

test('a missing original message falls back once to the channel with the duplicate reason intact', async () => {
  const h = harness('vi', { missingOriginal: true });
  await h.service.notifyRequesterAboutDecision(h.payload, { ok: false, isDuplicate: true }, true);
  assert.equal(h.replies.length, 0);
  assert.equal(h.sends.length, 1);
  assert.match(textOf(h.sends[0]), words.vi.duplicate);
  assert.match(textOf(h.sends[0]), words.vi.kept);
});
