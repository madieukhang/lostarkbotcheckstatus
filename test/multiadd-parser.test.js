import test from 'node:test';
import assert from 'node:assert/strict';

import ExcelJS from 'exceljs';

import {
  MULTIADD_MAX_FIELD_LENGTH,
  MULTIADD_MAX_UNZIPPED_BYTES,
  cellToString,
  parseMultiaddFile,
  validateMultiaddRow,
} from '../bot/services/multiadd/parser.js';

async function entriesWorkbook(...rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Entries');
  sheet.addRow(['Name', 'Type', 'Reason', 'Raid', 'Logs', 'Image', 'Scope']);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('cellToString normalizes the ExcelJS value shapes through one reader table', () => {
  assert.equal(cellToString(null), '');
  assert.equal(cellToString('  text  '), 'text');
  assert.equal(cellToString(42), '42');
  assert.equal(cellToString(false), 'false');
  assert.equal(cellToString({ hyperlink: ' https://example.com ' }), 'https://example.com');
  assert.equal(cellToString({ richText: [{ text: 'Rich' }, { text: ' Text' }] }), 'Rich Text');
  assert.equal(cellToString({ formula: '1+1', result: 2 }), '2');
});

test('multiadd validation preserves warning-before-duplicate ordering', () => {
  const row = {
    rowNum: 4,
    name: 'Alpha',
    type: 'white',
    reason: 'reason',
    raid: '',
    logs: '',
    image: '',
    scope: 'server',
  };

  const result = validateMultiaddRow(row, {
    acceptedCount: 1,
    seenNames: new Set(['alpha']),
  });

  assert.deepEqual(result, {
    error: 'Row 4: duplicate name "Alpha" already appears earlier in the file.',
    warnings: ['Row 4: scope is ignored for type "white" (blacklist only).'],
  });
});

test('parseMultiaddFile applies ordered rules and only accepts valid unique rows', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Entries');
  sheet.addRow(['Name', 'Type', 'Reason', 'Raid', 'Logs', 'Image', 'Scope']);
  sheet.addRow(['Alpha', 'black', 'reason', '', 'https://logs.example', '', 'global']);
  sheet.addRow(['Beta', 'white', 'reason', '', '', '', 'server']);
  sheet.addRow(['alpha', 'watch', 'duplicate', '', '', '', '']);

  const result = await parseMultiaddFile(await workbook.xlsx.writeBuffer());

  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map(({ name, scope }) => ({ name, scope })), [
    { name: 'Alpha', scope: 'global' },
    { name: 'Beta', scope: '' },
  ]);
  assert.deepEqual(result.errors, [
    'Row 3: scope is ignored for type "white" (blacklist only).',
    'Row 4: duplicate name "alpha" already appears earlier in the file.',
  ]);
});

test('parseMultiaddFile refuses a small workbook that unpacks past the budget', async () => {
  const buffer = await entriesWorkbook(['Alpha', 'black', 'a'.repeat(MULTIADD_MAX_UNZIPPED_BYTES + 1), '', '', '', '']);
  assert.ok(buffer.length < 1024 * 1024, 'the file must pass the 1 MiB upload cap');

  const result = await parseMultiaddFile(buffer);

  assert.equal(result.ok, false);
  assert.match(result.error, /unpacks to more than 8 MiB/);
  assert.deepEqual(result.rows, []);
});

test('parseMultiaddFile measures a workbook with bytes prepended where JSZip reads it', async () => {
  // JSZip shifts every offset past the prepended bytes and still loads the
  // workbook, so an unshifted walk would miss the entries it inflates.
  const bomb = await entriesWorkbook(['Alpha', 'black', 'a'.repeat(MULTIADD_MAX_UNZIPPED_BYTES + 1), '', '', '', '']);

  const result = await parseMultiaddFile(Buffer.concat([Buffer.alloc(100), bomb]));

  assert.equal(result.ok, false);
  assert.match(result.error, /unpacks to more than 8 MiB/);
});

test('parseMultiaddFile rejects a row whose field is longer than /la-list add accepts', async () => {
  const result = await parseMultiaddFile(await entriesWorkbook(
    ['Alpha', 'black', 'r'.repeat(MULTIADD_MAX_FIELD_LENGTH + 1), '', '', '', ''],
    ['Beta', 'black', 'r'.repeat(MULTIADD_MAX_FIELD_LENGTH), '', '', '', ''],
  ));

  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map(({ name }) => name), ['Beta']);
  assert.deepEqual(result.errors, [`Row 2: "reason" is longer than ${MULTIADD_MAX_FIELD_LENGTH} characters.`]);
});
