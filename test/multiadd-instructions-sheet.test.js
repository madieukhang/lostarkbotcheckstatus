import test from 'node:test';
import assert from 'node:assert/strict';

import { MIN_TRACKED_ITEM_LEVEL } from '../bot/config/itemLevelThreshold.js';
import { buildMultiaddTemplate } from '../bot/services/multiadd/template.js';

test('multiadd instructions sheet states the tracked item level gate', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildMultiaddTemplate());

  const gateRow = [];
  workbook.getWorksheet('Instructions').eachRow((row) => {
    if (row.getCell(1).value === 'ilvl gate') gateRow.push(String(row.getCell(2).value));
  });

  assert.equal(gateRow.length, 1);
  assert.ok(gateRow[0].includes(String(MIN_TRACKED_ITEM_LEVEL)));
});
