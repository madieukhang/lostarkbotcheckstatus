/**
 * services/multiadd/parser.js
 * Parse the user-uploaded .xlsx file produced by `/la-list multiadd
 * action:download`. Tolerates ExcelJS's many cell-value shapes (plain,
 * hyperlink, richText, formula `result`) so callers don't have to
 * normalize. Header row is found dynamically by scanning column A for
 * "name" · keeps the template free to add decorative rows above the
 * table without breaking the parser.
 */

import { RAIDS } from '../../models/Raid.js';
import {
  EXAMPLE_REASON_PREFIX,
  MULTIADD_MAX_ROWS,
} from './template.js';

const VALID_RAIDS = new Set(RAIDS);
const VALID_TYPES = new Set(['black', 'white', 'watch']);
const VALID_SCOPES = new Set(['global', 'server']);

const CELL_VALUE_READERS = [
  { matches: (value) => value == null, read: () => '' },
  { matches: (value) => typeof value === 'string', read: (value) => value },
  {
    matches: (value) => ['number', 'boolean'].includes(typeof value),
    read: (value) => String(value),
  },
  {
    matches: (value) => typeof value === 'object' && 'hyperlink' in value,
    read: (value) => value.hyperlink || value.text || '',
  },
  {
    matches: (value) => typeof value === 'object' && Array.isArray(value.richText),
    read: (value) => value.richText.map((part) => part.text || '').join(''),
  },
  {
    matches: (value) => typeof value === 'object' && 'result' in value,
    read: (value) => cellToString(value.result),
  },
];

const ROW_VALIDATION_RULES = [
  {
    invalid: (_row, context) => context.acceptedCount >= MULTIADD_MAX_ROWS,
    message: (row) => `Row ${row.rowNum}: exceeds ${MULTIADD_MAX_ROWS}-row limit · skipped.`,
  },
  {
    invalid: (row) => !row.name,
    message: (row) => `Row ${row.rowNum}: missing required field "name".`,
  },
  {
    invalid: (row) => !row.type,
    message: (row) => `Row ${row.rowNum}: missing required field "type".`,
  },
  {
    invalid: (row) => !VALID_TYPES.has(row.type),
    message: (row) => `Row ${row.rowNum}: type must be black/white/watch (got "${row.type}").`,
  },
  {
    invalid: (row) => !row.reason,
    message: (row) => `Row ${row.rowNum}: missing required field "reason".`,
  },
  {
    invalid: (row) => row.raid && !VALID_RAIDS.has(row.raid),
    message: (row) => `Row ${row.rowNum}: raid must be one of [${RAIDS.join(', ')}] (got "${row.raid}").`,
  },
  {
    invalid: (row) => row.logs && !/^https?:\/\//i.test(row.logs),
    message: (row) => `Row ${row.rowNum}: "logs" must start with http:// or https://.`,
  },
  {
    invalid: (row) => row.image && !/^https?:\/\//i.test(row.image),
    message: (row) => `Row ${row.rowNum}: "image" must start with http:// or https://.`,
  },
  {
    invalid: (row) => row.scope && !VALID_SCOPES.has(row.scope),
    message: (row) => `Row ${row.rowNum}: scope must be global/server (got "${row.scope}").`,
  },
  {
    invalid: (row) => row.scope && row.type !== 'black',
    message: (row) => `Row ${row.rowNum}: scope is ignored for type "${row.type}" (blacklist only).`,
    warning: true,
  },
  {
    invalid: (row, context) => context.seenNames.has(row.name.toLowerCase()),
    message: (row) => `Row ${row.rowNum}: duplicate name "${row.name}" already appears earlier in the file.`,
  },
];

/**
 * Coerce an ExcelJS cell value (any of: string, number, boolean,
 * hyperlink object, richText array, formula result wrapper) to a
 * trimmed string. Returns '' for null/undefined.
 * @param {*} value - cell value from ExcelJS
 * @returns {string}
 */
export function cellToString(value) {
  const reader = CELL_VALUE_READERS.find(({ matches }) => matches(value));
  return String(reader ? reader.read(value) : value).trim();
}

/**
 * Apply the ordered multiadd rules. Warnings accumulate, while the first
 * blocking rule stops validation exactly where the former guard chain did.
 */
export function validateMultiaddRow(row, context) {
  const warnings = [];
  for (const rule of ROW_VALIDATION_RULES) {
    if (!rule.invalid(row, context)) continue;
    const message = rule.message(row);
    if (rule.warning) {
      warnings.push(message);
      continue;
    }
    return { error: message, warnings };
  }
  return { error: null, warnings };
}

function readMultiaddRow(row, rowNum) {
  return {
    rowNum,
    name: cellToString(row.getCell(1).value),
    type: cellToString(row.getCell(2).value).toLowerCase(),
    reason: cellToString(row.getCell(3).value),
    raid: cellToString(row.getCell(4).value),
    logs: cellToString(row.getCell(5).value),
    image: cellToString(row.getCell(6).value),
    scope: cellToString(row.getCell(7).value).toLowerCase(),
  };
}

/**
 * Parse a multiadd .xlsx buffer into validated row records. Returns a
 * `{ ok, error?, rows, errors }` envelope · `ok: false` covers
 * transport/file-format failures (no exceljs, not a valid xlsx, no
 * worksheet), `errors[]` covers per-row validation issues that don't
 * abort the parse.
 * @param {Buffer} buffer - raw xlsx bytes
 * @returns {Promise<{ok: boolean, error?: string, rows: Array, errors: Array}>}
 */
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

    const parsedRow = readMultiaddRow(row, rowNum);
    if (!parsedRow.name && !parsedRow.type && !parsedRow.reason) return;
    if (parsedRow.reason.startsWith(EXAMPLE_REASON_PREFIX)) return;

    const validation = validateMultiaddRow(parsedRow, {
      acceptedCount: rows.length,
      seenNames,
    });
    errors.push(...validation.warnings);
    if (validation.error) {
      errors.push(validation.error);
      return;
    }
    seenNames.add(parsedRow.name.toLowerCase());

    rows.push({
      ...parsedRow,
      scope: parsedRow.type === 'black' ? parsedRow.scope : '',
    });
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
