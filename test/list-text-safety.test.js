import test from 'node:test';
import assert from 'node:assert/strict';
import { buildListEntryReasonField } from '../bot/handlers/list/entryCardFields.js';
import { buildBroadcastFields } from '../bot/handlers/list/services/broadcasts.js';
import { buildEvidenceEmbed } from '../bot/handlers/list/view/ui.js';
import { buildCheckEntryDetailsEmbed } from '../bot/handlers/list/check/ui.js';
import { buildVisibleRosterPresentation } from '../bot/handlers/roster/command.js';
import { validateMultiaddRow } from '../bot/services/multiadd/parser.js';
import { codeSpanText, isSafeLogsUrl, storedText } from '../bot/utils/discordText.js';
import { formatCheckResults } from '../bot/services/list-check/format.js';
import { buildHiddenFields } from '../bot/handlers/roster/hiddenRoster.js';
import { buildListPageEmbed } from '../bot/handlers/list/view/ui.js';
import { buildNoteAddedPayload } from '../bot/handlers/list/notes/addedCard.js';
import { buildNoteHistoryPayload } from '../bot/handlers/list/notes/historyView.js';
import { buildDuplicateApprovalEmbed } from '../bot/handlers/list/duplicate-ui.js';
import { buildListEditPlan } from '../bot/handlers/list/edit/plan.js';
import { buildListEntryInlineFields } from '../bot/handlers/list/entryCardFields.js';
import { getListContext } from '../bot/handlers/list/helpers.js';

// Text one member stores is shown to every guild, so a masked link in it
// must show as typed and never as a link.
const PHISH = '[Verify your account](https://evil.example/login)';
const SHOWN = '\\[Verify your account\\](https://evil.example/login)';

const allText = (embed) => JSON.stringify(embed.toJSON ? embed.toJSON() : embed);

test('a reason shows its masked link as text on entry cards', () => {
  const field = buildListEntryReasonField({ reason: PHISH, lang: 'en' });
  assert.ok(field.value.includes(SHOWN), field.value);
  const edited = buildListEntryReasonField({ reason: 'new', previousReason: PHISH, lang: 'en' });
  assert.ok(!edited.value.includes(`~~${PHISH}`), edited.value);
});

test('a reason keeps its bold and plain links', () => {
  const field = buildListEntryReasonField({ reason: '**left** see https://lostark.bible/logs/1', lang: 'en' });
  assert.ok(field.value.startsWith('**left** see https://lostark.bible/logs/1'), field.value);
});

test('the list-check detail card and the roster card show a reason as text', () => {
  const entry = { _id: 'a'.repeat(24), name: 'Main', reason: PHISH, allCharacters: ['Main'] };
  assert.ok(allText(buildCheckEntryDetailsEmbed(entry, { lang: 'en' })).includes(JSON.stringify(SHOWN).slice(1, -1)));
  const { embed } = buildVisibleRosterPresentation({
    name: 'Main', lang: 'en', previousSnapshots: new Map(),
    characters: [{ name: 'Main', className: 'Bard', itemLevel: '1730', combatScore: '3000' }],
    matches: { blacklist: { ...entry } },
  });
  assert.ok(!allText(embed).includes(JSON.stringify(PHISH).slice(1, -1)), 'no raw masked link on the roster card');
});

test('a custom raid cannot close the code span it is shown in', () => {
  assert.equal(codeSpanText('x` [link](https://evil.example) `'), "x' [link](https://evil.example) '");
  const fields = buildBroadcastFields({
    entry: { name: 'Main', reason: 'r', raid: 'x` [link](https://evil.example) `' },
    action: 'added',
    lang: 'en',
  });
  const raid = fields.find((field) => field.name.includes('🗡️'));
  assert.equal((raid.value.match(/`/g) || []).length, 2, raid.value);
});

test('a logs link is shown only when it is a plain https URL', () => {
  assert.equal(isSafeLogsUrl('https://lostark.bible/logs/abc'), true);
  for (const value of [
    'http://lostark.bible/logs/abc',
    'https://lostark.bible/x) [Re-verify](https://evil.example/login',
    'https://a.example/<x>',
    'https://a.example/ x',
    `https://a.example/${'a'.repeat(520)}`,
    'javascript:alert(1)',
    'not a url',
  ]) assert.equal(isSafeLogsUrl(value), false, value);

  const decorated = { _listType: 'black', _icon: 'x', _label: 'Blacklist', _color: 0xed4245, name: 'Main', reason: 'r' };
  const unsafe = buildEvidenceEmbed({ ...decorated, logsUrl: 'https://lostark.bible/x) [Re-verify](https://evil.example/login' }, '', { lang: 'en' });
  assert.ok(!allText(unsafe).includes('evil.example'), 'an unsafe logs link is not rendered');
  const safe = buildEvidenceEmbed({ ...decorated, logsUrl: 'https://lostark.bible/logs/abc' }, '', { lang: 'en' });
  assert.ok(allText(safe).includes('https://lostark.bible/logs/abc'));
});

test('multiadd refuses a logs cell that is not a plain https URL', () => {
  const row = { rowNum: 2, name: 'Alpha', type: 'black', reason: 'r', raid: 'Serca Hard', logs: 'https://lostark.bible/x) [y](https://evil.example', image: '', scope: '' };
  const result = validateMultiaddRow(row, { acceptedCount: 0, seenNames: new Set() });
  assert.match(result.error, /logs/);
});

test('multiadd refuses a reason over 1000 characters', () => {
  const row = { rowNum: 3, name: 'Alpha', type: 'black', reason: 'r'.repeat(1001), raid: 'Serca Hard', logs: '', image: '', scope: '' };
  const result = validateMultiaddRow(row, { acceptedCount: 0, seenNames: new Set() });
  assert.match(result.error, /reason/);
});

test('a stored reason of any length leaves the roster card buildable and short', () => {
  const entry = { _id: 'a'.repeat(24), name: 'Main', reason: 'x'.repeat(6000), allCharacters: ['Main'] };
  const { embed } = buildVisibleRosterPresentation({
    name: 'Main', lang: 'en', previousSnapshots: new Map(),
    characters: [{ name: 'Main', className: 'Bard', itemLevel: '1730', combatScore: '3000' }],
    matches: { blacklist: entry },
  });
  const description = embed.toJSON().description;
  assert.ok(description.length < 1500, `description is ${description.length} characters`);
});

// A reason is checked for a live link to its own target only, since cards
// also carry the bot's own character links; a raid must stay inside its
// code span, where a link renders as text.
const LIVE_PHISH = /(?<!\\)\]\(https:\/\/evil\.example\/login/;
const RAID_BREAK = 'Act 4 ` [Claim](https://evil.example/raid) `';

function shownText(embed) {
  const data = embed?.toJSON ? embed.toJSON() : embed;
  return [data.title, data.description, data.footer?.text, ...(data.fields || []).flatMap((f) => [f.name, f.value])]
    .filter(Boolean).join('\n');
}

function assertStoredTextSafe(text, label) {
  assert.equal(LIVE_PHISH.test(text), false, `${label}: live masked link in ${text}`);
  assert.equal(text.includes('Act 4 `'), false, `${label}: the raid closed its code span in ${text}`);
}

const STORED = {
  _id: 'e'.repeat(24), name: 'Main', reason: PHISH, raid: RAID_BREAK, scope: 'global',
  allCharacters: ['Main'], _listType: 'black', _icon: '⛔', _color: 0, addedAt: new Date('2026-11-01T00:00:00Z'),
};

test('storedText escapes before it cuts, so a cut never leaves a bracket live', () => {
  assert.equal(storedText(PHISH), SHOWN);
  const cut = storedText('['.repeat(1000), 950);
  assert.ok(cut.length <= 950, String(cut.length));
  assert.equal(/(?<!\\)\[/.test(cut), false);
  assert.equal(storedText(''), '');
});

test('the /la-check report lines show a stored reason and raid as text', () => {
  const lines = formatCheckResults([{
    inputName: 'Main', inputSource: 'ocr', name: 'Main', blackEntry: STORED, snapClassName: '', snapItemLevel: 1720,
  }], 'en');
  assertStoredTextSafe(lines.join('\n'), 'list-check');
});

test('the hidden roster hit rows show a stored reason and raid as text', () => {
  const fields = buildHiddenFields({
    meta: { guildName: 'Guild', world: 'Thaemine', strongholdName: 'Home', strongholdLevel: 70 },
    guildMembers: [], hits: { black: [STORED], white: [] }, deep: false, lang: 'en',
  });
  assertStoredTextSafe(shownText({ fields }), 'hidden roster');
});

test('/la-list view pages and the evidence detail show a stored reason and raid as text', () => {
  const page = buildListPageEmbed({
    allEntries: [STORED], currentType: 'black', getListContext, guildNameCache: new Map(),
    isOwnerGuild: false, itemsPerPage: 8, page: 0, statMap: new Map(),
  });
  assertStoredTextSafe(shownText(page), 'list page');
  assertStoredTextSafe(shownText(buildEvidenceEmbed(STORED, null, { lang: 'en' })), 'evidence detail');
});

test('entry cards, note cards and the duplicate comparison keep a stored raid in its code span', () => {
  const inline = buildListEntryInlineFields({
    type: 'black', raid: RAID_BREAK, scope: 'global', entry: STORED, icon: '⛔', labelCap: 'Blacklist', lang: 'en',
    previous: { raid: PHISH },
  });
  assertStoredTextSafe(shownText({ fields: inline }), 'entry card');
  assertStoredTextSafe(shownText(buildCheckEntryDetailsEmbed(STORED, { lang: 'en' })), 'check details');
  const added = buildNoteAddedPayload({
    entry: { ...STORED, notes: [{ at: new Date(), reason: PHISH, raid: RAID_BREAK }] },
    type: 'black', addedAlts: [], statMap: new Map(), lang: 'en',
  });
  assertStoredTextSafe(shownText(added.embeds[0]), 'note added');
  const duplicate = buildDuplicateApprovalEmbed(
    { ...STORED, addedByDisplayName: 'Reporter' },
    { name: 'Main', type: 'black', reason: PHISH, raid: RAID_BREAK, scope: 'global', requestedByDisplayName: 'Asker' },
    'en',
  );
  assertStoredTextSafe(shownText(duplicate), 'duplicate comparison');
});

test('the edit change summary keeps the old and new reason and raid inside their code spans', () => {
  const plan = buildListEditPlan({
    existing: { name: 'Main', reason: 'old ` [x](https://evil.example/login) `', raid: RAID_BREAK, allCharacters: [] },
    currentType: 'watch', newReason: 'new ` reason', newRaidInput: 'Act 4 ` custom', lang: 'en',
  });
  const text = plan.changes.join('\n');
  assert.equal(/old `|new `|Act 4 `/.test(text), false, text);
});

test('the note History card fits a 1000-character reason of brackets', () => {
  const payload = buildNoteHistoryPayload({
    entry: { _id: 'b'.repeat(24), name: 'Main', scope: 'global', notes: [{ at: new Date(), reason: '['.repeat(1000), raid: '' }] },
    type: 'black', page: 1, lang: 'en',
  });
  const value = payload.embeds[0].toJSON().fields[0].value;
  assert.ok(value.length <= 1024, String(value.length));
});
