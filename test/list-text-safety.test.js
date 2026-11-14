import test from 'node:test';
import assert from 'node:assert/strict';
import { buildListEntryReasonField } from '../bot/handlers/list/entryCardFields.js';
import { buildBroadcastFields } from '../bot/handlers/list/services/broadcasts.js';
import { buildEvidenceEmbed } from '../bot/handlers/list/view/ui.js';
import { buildCheckEntryDetailsEmbed } from '../bot/handlers/list/check/ui.js';
import { buildVisibleRosterPresentation } from '../bot/handlers/roster/command.js';
import { validateMultiaddRow } from '../bot/services/multiadd/parser.js';
import { codeSpanText, isSafeLogsUrl } from '../bot/utils/discordText.js';

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
