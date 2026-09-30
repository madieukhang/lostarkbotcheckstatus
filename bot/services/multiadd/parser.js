/**
 * services/multiadd/parser.js
 * Parse the user-uploaded .xlsx file produced by `/la-list multiadd
 * action:download`. Tolerates ExcelJS's many cell-value shapes (plain,
 * hyperlink, richText, formula `result`) so callers don't have to
 * normalize. Header row is found dynamically by scanning column A for
 * "name" · keeps the template free to add decorative rows above the
 * table without breaking the parser.
 */

import { inflateRawSync } from 'node:zlib';

import { RAIDS } from '../../models/Raid.js';
import {
  EXAMPLE_REASON_PREFIX,
  MULTIADD_MAX_ROWS,
} from './template.js';

// An .xlsx is a zip, so the 1 MiB upload cap bounds only compressed bytes:
// a workbook under 20 KB can hold a 16 MiB cell. The downloaded template
// unpacks to about 40 KB, and 30 rows of 6000-character Vietnamese fields
// to about 2 MB.
export const MULTIADD_MAX_UNZIPPED_BYTES = 8 * 1024 * 1024;
// Discord caps a slash-command string option at 6000 characters, so a row
// carries nothing longer than `/la-list add` accepts.
export const MULTIADD_MAX_FIELD_LENGTH = 6000;

const UNZIP_BUDGET_ERROR = `Workbook unpacks to more than ${MULTIADD_MAX_UNZIPPED_BYTES / 1024 / 1024} MiB. `
  + 'Remove extra sheets, pictures or very long cells and upload it again.';
// Record signatures and the field offsets used below follow PKWARE's
// APPNOTE.TXT: local file header 4.3.7, central directory header 4.3.12,
// end of central directory record 4.3.16.
const ZIP_END_OF_DIRECTORY = 0x06054b50;
const ZIP_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_HEADER = 0x04034b50;
// The end record is 22 bytes followed by a comment of up to 65535 bytes.
const ZIP_END_RECORD_LENGTH = 22;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
// The two compression methods JSZip, and so ExcelJS, can read.
const ZIP_ENTRY_READERS = {
  0: (data) => data,
  8: (data, maxOutputLength) => inflateRawSync(data, { maxOutputLength }),
};
// [offset, byte width] of the fields that make JSZip read ZIP64 records when
// they hold their maximum value. Those records can point at a different
// directory than the one walked here, so such archives are refused.
const ZIP64_END_FIELDS = [[4, 2], [6, 2], [8, 2], [10, 2], [12, 4], [16, 4]];
const ZIP64_ENTRY_FIELDS = [[20, 4], [24, 4], [42, 4]];

function hasZip64Marker(buffer, start, fields) {
  return fields.some(([field, width]) => buffer.readUIntLE(start + field, width) === 2 ** (8 * width) - 1);
}

function findZipEnd(buffer) {
  const earliest = Math.max(0, buffer.length - ZIP_END_RECORD_LENGTH - ZIP_MAX_COMMENT_LENGTH);
  for (let offset = buffer.length - ZIP_END_RECORD_LENGTH; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_DIRECTORY) return offset;
  }
  throw new Error('zip end record not found');
}

/**
 * Unpack every zip entry against a byte budget, discarding the output. The
 * bound comes from inflating, never from the sizes the zip declares. The
 * walk reads the records JSZip will: it follows directory signatures rather
 * than the declared entry count, and shifts every offset by the bytes found
 * before the directory, as JSZip does for a zip with data prepended. Methods
 * and compressed sizes come from the central directory, which stays filled
 * in when a local header defers them to a data descriptor.
 * @param {Buffer} buffer raw .xlsx bytes
 * @param {number} budget unpacked bytes allowed across all entries
 * @returns {boolean} whether every entry unpacked within the budget
 * @throws {Error} when the zip cannot be read, or with code
 *   ERR_BUFFER_TOO_LARGE when one deflated entry alone passes the budget
 */
function unzipsWithin(buffer, budget) {
  const end = findZipEnd(buffer);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  const shift = end - directoryOffset - buffer.readUInt32LE(end + 12);
  if (shift < 0 || hasZip64Marker(buffer, end, ZIP64_END_FIELDS)) {
    throw new Error('unsupported zip layout');
  }
  let remaining = budget;
  let entry = shift + directoryOffset;
  while (buffer.readUInt32LE(entry) === ZIP_DIRECTORY_ENTRY) {
    const readEntry = ZIP_ENTRY_READERS[buffer.readUInt16LE(entry + 10)];
    const localHeader = shift + buffer.readUInt32LE(entry + 42);
    if (!readEntry || hasZip64Marker(buffer, entry, ZIP64_ENTRY_FIELDS)
      || buffer.readUInt32LE(localHeader) !== ZIP_LOCAL_HEADER) {
      throw new Error('unsupported zip entry');
    }
    const dataStart = localHeader + 30 + buffer.readUInt16LE(localHeader + 26) + buffer.readUInt16LE(localHeader + 28);
    const compressed = buffer.subarray(dataStart, dataStart + buffer.readUInt32LE(entry + 20));
    remaining -= readEntry(compressed, remaining + 1).length;
    if (remaining < 0) return false;
    entry += 46 + buffer.readUInt16LE(entry + 28) + buffer.readUInt16LE(entry + 30) + buffer.readUInt16LE(entry + 32);
  }
  return true;
}

function unzipBudgetError(buffer) {
  try {
    return unzipsWithin(buffer, MULTIADD_MAX_UNZIPPED_BYTES) ? null : UNZIP_BUDGET_ERROR;
  } catch (err) {
    return err.code === 'ERR_BUFFER_TOO_LARGE' ? UNZIP_BUDGET_ERROR : `File is not a valid .xlsx (${err.message})`;
  }
}

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

const MULTIADD_TEXT_FIELDS = ['name', 'type', 'reason', 'raid', 'logs', 'image', 'scope'];
const overlongField = (row) => MULTIADD_TEXT_FIELDS.find((field) => row[field].length > MULTIADD_MAX_FIELD_LENGTH);

// The length rule runs before any rule that quotes a field back in its message.
const ROW_VALIDATION_RULES = [
  {
    invalid: (_row, context) => context.acceptedCount >= MULTIADD_MAX_ROWS,
    message: (row) => `Row ${row.rowNum}: exceeds ${MULTIADD_MAX_ROWS}-row limit · skipped.`,
  },
  {
    invalid: (row) => overlongField(row) !== undefined,
    message: (row) => `Row ${row.rowNum}: "${overlongField(row)}" is longer than ${MULTIADD_MAX_FIELD_LENGTH} characters.`,
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

  const unzipError = unzipBudgetError(buffer);
  if (unzipError) {
    return { ok: false, error: unzipError, rows: [], errors: [] };
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
