import { RAIDS } from '../../models/Raid.js';
import {
  EXAMPLE_REASON_PREFIX,
  MULTIADD_MAX_ROWS,
} from './template.js';

const VALID_RAIDS = new Set(RAIDS);
const VALID_TYPES = new Set(['black', 'white', 'watch']);
const VALID_SCOPES = new Set(['global', 'server']);

export function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (typeof value === 'object' && 'hyperlink' in value) {
    return String(value.hyperlink || value.text || '').trim();
  }
  if (typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map((r) => r.text || '').join('').trim();
  }
  if (typeof value === 'object' && 'result' in value) {
    return cellToString(value.result);
  }
  return String(value).trim();
}

export async function parseMultiaddFile(buffer) {
  let ExcelJS;
  try {
    ExcelJS = (await import('exceljs')).default;
  } catch (err) {
    return { ok: false, error: `Failed to load exceljs: ${err.message}`, rows: [], errors: [] };
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    return {
      ok: false,
      error: `File is not a valid .xlsx (ExcelJS error: ${err.message})`,
      rows: [],
      errors: [],
    };
  }

  const sheet = wb.getWorksheet('Entries') || wb.worksheets[0];
  if (!sheet) {
    return { ok: false, error: 'No worksheet found in file.', rows: [], errors: [] };
  }

  const rows = [];
  const errors = [];
  const seenNames = new Set();
  let acceptedCount = 0;
  let headerRowNum = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (headerRowNum === 0) {
      const cellA = cellToString(row.getCell(1).value).toLowerCase();
      if (cellA === 'name') {
        headerRowNum = rowNum;
      }
      return;
    }

    if (rowNum <= headerRowNum) return;

    const name = cellToString(row.getCell(1).value);
    const type = cellToString(row.getCell(2).value).toLowerCase();
    const reason = cellToString(row.getCell(3).value);
    const raid = cellToString(row.getCell(4).value);
    const logs = cellToString(row.getCell(5).value);
    const image = cellToString(row.getCell(6).value);
    const scope = cellToString(row.getCell(7).value).toLowerCase();

    if (!name && !type && !reason) return;
    if (reason.startsWith(EXAMPLE_REASON_PREFIX)) return;

    if (acceptedCount >= MULTIADD_MAX_ROWS) {
      errors.push(`Row ${rowNum}: exceeds ${MULTIADD_MAX_ROWS}-row limit — skipped.`);
      return;
    }

    if (!name) {
      errors.push(`Row ${rowNum}: missing required field "name".`);
      return;
    }
    if (!type) {
      errors.push(`Row ${rowNum}: missing required field "type".`);
      return;
    }
    if (!VALID_TYPES.has(type)) {
      errors.push(`Row ${rowNum}: type must be black/white/watch (got "${type}").`);
      return;
    }
    if (!reason) {
      errors.push(`Row ${rowNum}: missing required field "reason".`);
      return;
    }

    if (raid && !VALID_RAIDS.has(raid)) {
      errors.push(
        `Row ${rowNum}: raid must be one of [${RAIDS.join(', ')}] (got "${raid}").`
      );
      return;
    }
    if (logs && !/^https?:\/\//i.test(logs)) {
      errors.push(`Row ${rowNum}: "logs" must start with http:// or https://.`);
      return;
    }
    if (image && !/^https?:\/\//i.test(image)) {
      errors.push(`Row ${rowNum}: "image" must start with http:// or https://.`);
      return;
    }
    if (scope && !VALID_SCOPES.has(scope)) {
      errors.push(`Row ${rowNum}: scope must be global/server (got "${scope}").`);
      return;
    }

    if (scope && type !== 'black') {
      errors.push(`Row ${rowNum}: scope is ignored for type "${type}" (blacklist only).`);
    }

    const nameLower = name.toLowerCase();
    if (seenNames.has(nameLower)) {
      errors.push(`Row ${rowNum}: duplicate name "${name}" already appears earlier in the file.`);
      return;
    }
    seenNames.add(nameLower);

    rows.push({
      rowNum,
      name,
      type,
      reason,
      raid,
      logs,
      image,
      scope: type === 'black' ? scope : '',
    });
    acceptedCount++;
  });

  if (headerRowNum === 0) {
    return {
      ok: false,
      error: 'Header row not found. Expected a row with "name" in column A.',
      rows: [],
      errors: [],
    };
  }

  return { ok: true, rows, errors };
}
