import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalServices } from '../bot/handlers/list/services/approvals.js';
import { t } from '../bot/services/i18n/index.js';
import { COLORS } from '../bot/utils/ui.js';

const words = {
  en: { duplicate: /already listed/i, kept: /kept the existing entry/i, failed: /could not save it/i, rejected: /was rejected/i, approved: /was approved and saved/i },
  vi: { duplicate: /đã có trong list/i, kept: /giữ entry hiện tại/i, failed: /chưa lưu được/i, rejected: /bị từ chối/i, approved: /đã được duyệt và lưu/i },
  jp: { duplicate: /すでに list にあり/, kept: /既存の entry を残しました/, failed: /保存できませんでした/, rejected: /却下されました/, approved: /承認され、保存されました/ },
};

function harness(lang, { missingOriginal = false, snapshot = null, snapshotError = null } = {}) {
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
    RosterSnapshotModel: { findOne: () => ({
      collation() { return this; },
      lean: async () => {
        if (snapshotError) throw snapshotError;
        return snapshot;
      },
    }) },
  });
  const payload = {
    guildId: 'guild', channelId: 'channel', requestMessageId: 'request',
    requestedByUserId: 'requester', action: 'add', name: 'Samplechar',
    type: 'black', scope: 'global', raid: 'Kazeros Hard',
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
      const embed = notice.embeds[0].toJSON();
      assert.equal(embed.color, color);
      // The card reads like the /la-list add card: List · Decision · Name,
      // then the list, raid and scope the request asked for.
      assert.match(embed.title, new RegExp(`Blacklist · ${t(`dialogue.approval.public.decisions.${state}`, lang)} · Samplechar$`));
      assert.deepEqual(
        embed.fields.slice(0, 3).map((field) => field.value),
        ['⛔ Blacklist', '`Kazeros Hard`', t('dialogue.approval.scopeTag.global', lang)],
      );
      assert.doesNotMatch(JSON.stringify(embed.fields), /Private report content/);
    });
  }
}

test('the decision card shows the class from the roster snapshot, and a failed read still sends it', async () => {
  const known = harness('en', { snapshot: { name: 'Samplechar', className: 'Berserker' } });
  await known.service.notifyRequesterAboutDecision(known.payload, { ok: true }, false);
  // No emoji bootstrap in tests, so the class name stands in for its icon.
  assert.match(known.replies[0].embeds[0].toJSON().description, /Berserker \*\*\[Samplechar\]/);

  const broken = harness('en', { snapshotError: new Error('snapshot read failed') });
  await broken.service.notifyRequesterAboutDecision(broken.payload, { ok: true }, false);
  assert.equal(broken.replies.length, 1);
  assert.match(broken.replies[0].embeds[0].toJSON().description, /^Your request to add \*\*\[Samplechar\]/);
});

test('a missing original message falls back once to the channel with the duplicate reason intact', async () => {
  const h = harness('vi', { missingOriginal: true });
  await h.service.notifyRequesterAboutDecision(h.payload, { ok: false, isDuplicate: true }, true);
  assert.equal(h.replies.length, 0);
  assert.equal(h.sends.length, 1);
  assert.match(textOf(h.sends[0]), words.vi.duplicate);
  assert.match(textOf(h.sends[0]), words.vi.kept);
});
