import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache, t as translate } from '../bot/services/i18n/index.js';
import { refreshLegacyImageUrl, resolveDisplayImageUrl } from '../bot/utils/imageRehost.js';
import { ENTRY_EVIDENCE_PREFIX, buildBroadcastEvidenceButton } from '../bot/handlers/list/evidence/broadcastButton.js';
import { createEntryEvidenceButtonHandler } from '../bot/handlers/list/evidence/entryButton.js';
import { buildCheckEntryDetailsEmbed } from '../bot/handlers/list/check/ui.js';
import { decorateListEntry } from '../bot/handlers/list/helpers.js';
import { buildBroadcastPayload } from '../bot/handlers/list/services/broadcasts.js';

const DISCORD_LINK = 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1&is=2&hm=3';
const FRESH_LINK = 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=9';
const client = { token: 'bot-token' };
const legacy = {
  _id: 'e'.repeat(24), name: 'Iceqsl', scope: 'global', reason: 'test', raid: '',
  imageUrl: DISCORD_LINK, allCharacters: [], addedAt: new Date('2026-03-27T00:00:00Z'),
};
const refreshed = { ok: true, status: 200, json: async () => ({ refreshed_urls: [{ original: DISCORD_LINK, refreshed: FRESH_LINK }] }) };
const gone = { ok: false, status: 400, json: async () => ({}) };
const missingFile = { ok: false, status: 404 };

// Answers each request with the next response; the last one repeats.
function mockDiscord(t, ...responses) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return responses[Math.min(requests.length, responses.length) - 1];
  });
  return requests;
}

test('a link on another host is used as stored, without asking Discord', async t => {
  const requests = mockDiscord(t, gone);
  assert.deepEqual(await refreshLegacyImageUrl('https://i.imgur.com/proof.png', client), { url: 'https://i.imgur.com/proof.png', error: '' });
  assert.equal(requests.length, 0);
});

test('a stored Discord link is re-signed with the bot token before it is shown', async t => {
  const requests = mockDiscord(t, refreshed);
  assert.equal(await resolveDisplayImageUrl(legacy, client), FRESH_LINK);
  assert.equal(requests[0].url, 'https://discord.com/api/v10/attachments/refresh-urls');
  assert.equal(requests[0].init.headers.Authorization, 'Bot bot-token');
  assert.deepEqual(JSON.parse(requests[0].init.body), { attachment_urls: [DISCORD_LINK] });
});

test('a Discord link Discord no longer serves resolves to nothing and says why', async t => {
  mockDiscord(t, gone);
  assert.deepEqual(await refreshLegacyImageUrl(DISCORD_LINK, client), { url: '', error: 'refresh API returned 400' });
  assert.equal(await resolveDisplayImageUrl(legacy, client), '');
});

test('a re-signed Discord link whose file is gone resolves to nothing', async t => {
  // Discord re-signs links to deleted ephemeral attachments without an error.
  const requests = mockDiscord(t, refreshed, missingFile);
  assert.deepEqual(await refreshLegacyImageUrl(DISCORD_LINK, client), { url: '', error: 'file returned 404' });
  assert.deepEqual([requests[1].url, requests[1].init.method], [FRESH_LINK, 'HEAD']);
});

test('an entry outside the archive gets a View evidence button that names the entry', () => {
  const button = buildBroadcastEvidenceButton(legacy, { type: 'black' }).toJSON();
  assert.equal(button.custom_id, `${ENTRY_EVIDENCE_PREFIX}:black:${legacy._id}`);
  assert.equal(button.label, 'View evidence');
  assert.equal(button.url, undefined);
});

test('a broadcast opens a stored link in Discord unless the entry was just removed', () => {
  const evidenceOf = action => buildBroadcastPayload({ action, entry: legacy, type: 'black', statMap: new Map(), lang: 'en' })
    .components[0].toJSON().components[0];
  assert.equal(evidenceOf('added').custom_id, `${ENTRY_EVIDENCE_PREFIX}:black:${legacy._id}`);
  assert.equal(evidenceOf('removed').url, DISCORD_LINK);
});

test('the check details card explains a Discord link that is gone', () => {
  const embed = buildCheckEntryDetailsEmbed(decorateListEntry(legacy, 'black'), { displayUrl: '' }).toJSON();
  assert.equal(embed.fields.at(-1).value, translate('listView.evidence.legacyGone', 'en'));
});

function clickView(t, entry) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(Blacklist, 'findOne', () => ({ lean: async () => entry }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  const replies = [];
  const interaction = {
    customId: `${ENTRY_EVIDENCE_PREFIX}:black:${legacy._id}`, user: { id: 'viewer' }, guildId: 'guild',
    deferReply: async () => {}, editReply: async payload => replies.push(payload),
  };
  return createEntryEvidenceButtonHandler({ client })(interaction).then(() => replies[0].embeds[0].toJSON());
}

test('View evidence shows a re-signed Discord link to the viewer', async t => {
  mockDiscord(t, refreshed);
  const embed = await clickView(t, legacy);
  assert.equal(embed.image.url, FRESH_LINK);
  assert.equal(embed.footer.text, translate('dialogue.evidence.legacy.footer', 'en'));
});

test('View evidence explains that a Discord link outside the archive is gone', async t => {
  mockDiscord(t, gone);
  const embed = await clickView(t, legacy);
  assert.match(embed.title, new RegExp(translate('dialogue.evidence.legacyGone.title', 'en')));
  assert.equal(embed.image, undefined);
});

test('View evidence on a removed entry says the entry is gone', async t => {
  const embed = await clickView(t, null);
  assert.match(embed.title, new RegExp(translate('dialogue.check.entryRemoved.title', 'en')));
});
