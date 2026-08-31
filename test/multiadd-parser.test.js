import test from 'node:test';
import assert from 'node:assert/strict';

import ExcelJS from 'exceljs';

import {
  cellToString,
  parseMultiaddFile,
  validateMultiaddRow,
} from '../bot/services/multiadd/parser.js';

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
