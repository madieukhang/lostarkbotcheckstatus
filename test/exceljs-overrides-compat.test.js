import assert from 'node:assert/strict';
import test from 'node:test';

test('ExcelJS remains compatible with the patched uuid override', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Entries');
  sheet.addRows([[1], [2]]);
  sheet.addConditionalFormatting({
    ref: 'A1:A2',
    rules: [{
      type: 'dataBar',
      cfvo: [{ type: 'min' }, { type: 'max' }],
      color: { argb: 'FF638EC6' },
    }],
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer);

  assert.deepEqual([...buffer.subarray(0, 2)], [0x50, 0x4b]);
  assert.equal(reloaded.getWorksheet('Entries').conditionalFormattings.length, 1);
});
