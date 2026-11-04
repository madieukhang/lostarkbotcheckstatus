import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = '';
process.env.OFFICER_APPROVER_IDS = '';

const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { createEnrichHandlers } = await import('../bot/handlers/list/enrich/index.js');
const { COLORS } = await import('../bot/utils/ui.js');

function stubVietnamese(t) {
  clearUserLanguageCache();
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'vi' }) }));
  t.after(() => clearUserLanguageCache());
}

function interaction(extra = {}) {
  const payloads = [];
  return {
    payloads,
    user: { id: 'member-1', tag: 'Member#0001' },
    guild: { id: 'guild-1' },
    options: { getString: () => 'Mokoko', getInteger: () => null },
    reply: async (payload) => { payloads.push(payload); },
    update: async (payload) => { payloads.push(payload); },
    ...extra,
  };
}

const cardOf = (payload) => payload.embeds[0].toJSON();

test('enrich: a member is refused with the same officer-only guard as /la-list trust', async (t) => {
  stubVietnamese(t);
  const click = interaction();
  await createEnrichHandlers({ services: {} }).handleListEnrichCommand(click);

  const card = cardOf(click.payloads[0]);
  assert.ok(card.title.startsWith('🔒  '), card.title);
  assert.equal(card.color, COLORS.warning);
  assert.deepEqual(card.fields.map(({ name, value }) => [name, value]), [['👥 Ai dùng được', 'Officer · Senior']]);
  assert.ok(card.footer.text.startsWith('💡 '), card.footer.text);
});

test('enrich: cancelling a preview whose session is gone is an expired notice', async (t) => {
  stubVietnamese(t);
  const click = interaction({ customId: 'enrich:cancel:missing-session' });
  await createEnrichHandlers({ services: {} }).handleListEnrichCancelButton(click);

  const card = cardOf(click.payloads[0]);
  assert.ok(card.title.startsWith('⌛  '), card.title);
  assert.equal(card.color, COLORS.muted);
  assert.ok(card.footer.text.startsWith('💡 '), card.footer.text);
});
