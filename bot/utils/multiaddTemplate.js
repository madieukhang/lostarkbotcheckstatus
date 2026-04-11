/**
 * multiaddTemplate.js
 *
 * Standalone .xlsx template generator + parser for /list multiadd.
 * Kept in its own module so it has zero dependencies on config/db/discord,
 * making it trivially importable and testable in isolation. The only
 * internal import is the RAIDS enum, which is a pure data module.
 *
 * The template uses a layered visual layout:
 *   Row 1: gradient title banner (merged)
 *   Row 2: subtitle / quick-start hint (merged)
 *   Row 3: spacer
 *   Row 4: column header (the "real" table header — parser finds this by
 *          scanning for "name" in column A)
 *   Row 5-7: three color-coded example rows (black / white / watch) with
 *          reason prefixed "⚠️ EXAMPLE —" so the parser can safely skip
 *          them if the user forgets to delete.
 *   Row 8: spacer
 *   Row 9-13: blank placeholder rows with subtle borders + zebra stripes
 */

import { RAIDS } from '../../models/Raid.js';

// Max rows allowed in /list multiadd Excel file (excluding header)
export const MULTIADD_MAX_ROWS = 30;

// Pre-computed set for fast raid validation in parseMultiaddFile
const VALID_RAIDS = new Set(RAIDS);

// Inline-formula form for ExcelJS dropdown data validation.
// Format: `"Act4 Nor,Act4 Hard,Kazeros Nor,Kazeros Hard,Mordum Hard"`
// Excel limits inline validation formulae to 255 chars; a 10-raid future
// would still fit, but if it ever grows beyond that switch to a named range.
const RAID_DROPDOWN_FORMULA = `"${RAIDS.join(',')}"`;

/**
 * Marker prefix for example rows. Parser recognizes this and silently
 * skips the row so forgetful users don't accidentally add "ExampleName"
 * to the database. Keep in sync with buildMultiaddTemplate below.
 */
const EXAMPLE_REASON_PREFIX = '⚠️ EXAMPLE —';

// ---------- Palette (ARGB with FF alpha) ----------
// Core brand
const COLOR_BLURPLE = 'FF5865F2';
const COLOR_BLURPLE_DARK = 'FF4752C4';
const COLOR_BLURPLE_LIGHT = 'FF7289DA';
const COLOR_BLURPLE_BG = 'FFEEF0FC';
const COLOR_WHITE = 'FFFFFFFF';

// Example row tints — each list type gets its own color family
// Matches Discord's own black/white/watch accent colors (⛔/✅/⚠️)
const COLOR_EX_RED_BG = 'FFFEE2E2';
const COLOR_EX_RED_TEXT = 'FF991B1B';
const COLOR_EX_GREEN_BG = 'FFD1FAE5';
const COLOR_EX_GREEN_TEXT = 'FF065F46';
const COLOR_EX_YELLOW_BG = 'FFFEF3C7';
const COLOR_EX_YELLOW_TEXT = 'FF92400E';

// Neutral grays
const COLOR_GRAY_50 = 'FFF9FAFB';
const COLOR_GRAY_100 = 'FFF3F4F6';
const COLOR_GRAY_200 = 'FFE5E7EB';
const COLOR_GRAY_500 = 'FF6B7280';
const COLOR_GRAY_700 = 'FF374151';
const COLOR_BORDER = 'FFE5E7EB';

// Instructions sheet section colors — each section gets its own accent
const COLOR_SEC_BLUE_BG = 'FFDBEAFE';
const COLOR_SEC_BLUE_TEXT = 'FF1E40AF';
const COLOR_SEC_PURPLE_BG = 'FFE9D5FF';
const COLOR_SEC_PURPLE_TEXT = 'FF6B21A8';
const COLOR_SEC_GREEN_BG = 'FFD1FAE5';
const COLOR_SEC_GREEN_TEXT = 'FF065F46';
const COLOR_SEC_AMBER_BG = 'FFFEF3C7';
const COLOR_SEC_AMBER_TEXT = 'FF92400E';
const COLOR_SEC_PINK_BG = 'FFFCE7F3';
const COLOR_SEC_PINK_TEXT = 'FF9D174D';

/** Thin border on all 4 sides using the template border color. */
function borderAll(color = COLOR_BORDER) {
  const side = { style: 'thin', color: { argb: color } };
  return { top: side, left: side, bottom: side, right: side };
}

/** Gradient fill object for Blurple banner (left → right). */
function gradientBlurple() {
  return {
    type: 'gradient',
    gradient: 'angle',
    degree: 0, // horizontal left-to-right
    stops: [
      { position: 0, color: { argb: COLOR_BLURPLE_DARK } },
      { position: 0.5, color: { argb: COLOR_BLURPLE } },
      { position: 1, color: { argb: COLOR_BLURPLE_LIGHT } },
    ],
  };
}

/**
 * Build an .xlsx template buffer for /list multiadd.
 * Returns a Buffer suitable for AttachmentBuilder.
 */
export async function buildMultiaddTemplate() {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lost Ark Bot';
  wb.created = new Date();

  // ============================================================
  // Sheet 1: Entries
  // ============================================================
  const sheet = wb.addWorksheet('Entries', {
    views: [{ state: 'frozen', ySplit: 4, zoomScale: 110 }],
    properties: { defaultRowHeight: 20 },
  });

  // Column widths (header labels set later on row 4 explicitly)
  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 11;
  sheet.getColumn(3).width = 40;
  sheet.getColumn(4).width = 18;
  sheet.getColumn(5).width = 42;
  sheet.getColumn(6).width = 42;
  sheet.getColumn(7).width = 11;

  // ---------- Row 1: Title banner (merged, gradient) ----------
  sheet.mergeCells('A1:G1');
  const titleRow = sheet.getRow(1);
  titleRow.height = 48;
  const titleCell = sheet.getCell('A1');
  titleCell.value = '📋  LOST ARK BOT — BULK ADD TEMPLATE';
  titleCell.font = {
    name: 'Segoe UI Semibold',
    bold: true,
    size: 18,
    color: { argb: COLOR_WHITE },
  };
  titleCell.fill = gradientBlurple();
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

  // ---------- Row 2: Subtitle / quick-start hint (merged) ----------
  sheet.mergeCells('A2:G2');
  const subtitleRow = sheet.getRow(2);
  subtitleRow.height = 24;
  const subtitleCell = sheet.getCell('A2');
  subtitleCell.value =
    'Fill up to 30 rows  ·  Delete the colored example rows before uploading  ·  See the "Instructions" tab for details';
  subtitleCell.font = {
    name: 'Segoe UI',
    italic: true,
    size: 10,
    color: { argb: COLOR_GRAY_500 },
  };
  subtitleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: COLOR_BLURPLE_BG },
  };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'center' };

  // ---------- Row 3: Spacer (thin horizontal breathing room) ----------
  sheet.getRow(3).height = 6;

  // ---------- Row 4: Column header (the "real" table header) ----------
  const headers = ['name', 'type', 'reason', 'raid', 'logs', 'image', 'scope'];
  const header = sheet.getRow(4);
  header.height = 28;
  for (let col = 1; col <= 7; col++) {
    const cell = header.getCell(col);
    cell.value = headers[col - 1];
    cell.font = {
      name: 'Segoe UI Semibold',
      bold: true,
      color: { argb: COLOR_WHITE },
      size: 11,
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLOR_BLURPLE },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = {
      top: { style: 'medium', color: { argb: COLOR_BLURPLE_DARK } },
      bottom: { style: 'medium', color: { argb: COLOR_BLURPLE_DARK } },
    };
  }

  // Auto-filter anchored on the header row
  sheet.autoFilter = { from: 'A4', to: 'G4' };

  // ---------- Rows 5-7: three color-coded example rows ----------
  // Each example gets: marker reason, distinct fill color, dark text.
  // Parser skips any row whose reason starts with EXAMPLE_REASON_PREFIX.
  const examples = [
    {
      name: 'ExamplePlayer1',
      type: 'black',
      reason: `${EXAMPLE_REASON_PREFIX} Griefing in Act4 Hard (delete this row)`,
      raid: 'Act4 Hard',
      logs: 'https://lostark.bible/character/NA/ExamplePlayer1/logs',
      image: 'https://cdn.discordapp.com/attachments/XXX/YYY/evidence.png',
      scope: 'global',
      bg: COLOR_EX_RED_BG,
      text: COLOR_EX_RED_TEXT,
    },
    {
      name: 'ExamplePlayer2',
      type: 'white',
      reason: `${EXAMPLE_REASON_PREFIX} Trusted static mate — 6 months (delete this row)`,
      raid: 'Kazeros Nor',
      logs: '',
      image: '',
      scope: '',
      bg: COLOR_EX_GREEN_BG,
      text: COLOR_EX_GREEN_TEXT,
    },
    {
      name: 'ExamplePlayer3',
      type: 'watch',
      reason: `${EXAMPLE_REASON_PREFIX} Inconsistent dps, investigating (delete this row)`,
      raid: 'Mordum Hard',
      logs: '',
      image: '',
      scope: '',
      bg: COLOR_EX_YELLOW_BG,
      text: COLOR_EX_YELLOW_TEXT,
    },
  ];

  examples.forEach((ex, i) => {
    const rowNum = 5 + i;
    const row = sheet.getRow(rowNum);
    row.height = 22;
    const values = [ex.name, ex.type, ex.reason, ex.raid, ex.logs, ex.image, ex.scope];
    for (let col = 1; col <= 7; col++) {
      const cell = row.getCell(col);
      cell.value = values[col - 1];
      cell.font = {
        name: 'Segoe UI',
        italic: true,
        size: 10,
        color: { argb: ex.text },
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: ex.bg },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      cell.border = borderAll();
    }
  });

  // ---------- Row 8: Spacer ----------
  sheet.getRow(8).height = 4;

  // ---------- Rows 9-13: blank placeholder rows with zebra stripes ----------
  for (let r = 9; r <= 13; r++) {
    const row = sheet.getRow(r);
    row.height = 22;
    for (let col = 1; col <= 7; col++) {
      const cell = row.getCell(col);
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      cell.border = borderAll();
      // Zebra stripe odd rows (9, 11, 13) with very light gray
      if (r % 2 === 1) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: COLOR_GRAY_50 },
        };
      }
    }
  }

  // ---------- Data validation dropdowns ----------
  // Range = rows 5 through (5 + MULTIADD_MAX_ROWS + 3):
  //   rows 5-7   = three example rows (deleted or replaced by user)
  //   rows 8+    = user data slots (up to MULTIADD_MAX_ROWS usable)
  // +3 keeps the full 30-row limit available even if the user only
  // replaces the examples in place instead of deleting them.
  const FIRST_DATA_ROW = 5;
  const LAST_DATA_ROW = 5 + MULTIADD_MAX_ROWS + 3; // examples + user rows
  for (let r = FIRST_DATA_ROW; r <= LAST_DATA_ROW; r++) {
    // type column (B) — black/white/watch
    sheet.getCell(`B${r}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"black,white,watch"'],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid type',
      error: 'type must be one of: black, white, watch',
    };
    // raid column (D) — enum from models/Raid.js, optional
    sheet.getCell(`D${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [RAID_DROPDOWN_FORMULA],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid raid',
      error: `raid must be one of: ${RAIDS.join(', ')}`,
    };
    // scope column (G) — global/server (blacklist only, optional)
    sheet.getCell(`G${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"global,server"'],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid scope',
      error: 'scope must be global or server (blacklist only)',
    };
  }

  // ============================================================
  // Sheet 2: Instructions (sectioned card layout)
  // ============================================================
  buildInstructionsSheet(wb);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Build the Instructions worksheet with a "card" layout: each section has
 * a colored banner row + lighter-tinted content rows, giving the sheet a
 * web-dashboard feel instead of plain key/value pairs.
 */
function buildInstructionsSheet(wb) {
  const ins = wb.addWorksheet('Instructions', {
    views: [{ state: 'frozen', ySplit: 3, zoomScale: 110 }],
    properties: { defaultRowHeight: 18 },
  });

  ins.getColumn(1).width = 22;
  ins.getColumn(2).width = 72;

  // ---------- Row 1: Title banner ----------
  ins.mergeCells('A1:B1');
  const titleCell = ins.getCell('A1');
  titleCell.value = '📖  INSTRUCTIONS — /list multiadd';
  titleCell.font = {
    name: 'Segoe UI Semibold',
    bold: true,
    size: 16,
    color: { argb: COLOR_WHITE },
  };
  titleCell.fill = gradientBlurple();
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ins.getRow(1).height = 42;

  // ---------- Row 2: Subtitle ----------
  ins.mergeCells('A2:B2');
  const subtitleCell = ins.getCell('A2');
  subtitleCell.value =
    'How to fill out and upload the bulk add template';
  subtitleCell.font = {
    name: 'Segoe UI',
    italic: true,
    size: 10,
    color: { argb: COLOR_GRAY_500 },
  };
  subtitleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: COLOR_BLURPLE_BG },
  };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ins.getRow(2).height = 22;

  // Row 3: spacer
  ins.getRow(3).height = 6;

  // ---------- Helper: section card ----------
  // Adds a section header row + content rows, all filled with the section's
  // color family. Each section visually "floats" as a card.
  const addCard = (title, bannerBg, bannerText, contentBg, items) => {
    // Card title banner
    ins.addRow([title, '']);
    const bannerRow = ins.lastRow;
    bannerRow.height = 26;
    ins.mergeCells(`A${bannerRow.number}:B${bannerRow.number}`);
    const bannerCell = bannerRow.getCell(1);
    bannerCell.font = {
      name: 'Segoe UI Semibold',
      bold: true,
      size: 12,
      color: { argb: bannerText },
    };
    bannerCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: bannerBg },
    };
    bannerCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    bannerCell.border = {
      top: { style: 'medium', color: { argb: bannerText } },
    };

    // Card content rows — each item is [key, value] or [null, info]
    for (const item of items) {
      const row = ins.addRow(item);
      row.height = 19;
      for (let col = 1; col <= 2; col++) {
        const cell = row.getCell(col);
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: contentBg },
        };
        cell.alignment = {
          vertical: 'middle',
          horizontal: col === 1 ? 'right' : 'left',
          indent: 1,
          wrapText: true,
        };
      }
      row.getCell(1).font = {
        name: 'Segoe UI Semibold',
        bold: true,
        size: 10,
        color: { argb: COLOR_GRAY_700 },
      };
      row.getCell(2).font = {
        name: 'Segoe UI',
        size: 10,
        color: { argb: COLOR_GRAY_700 },
      };
    }

    // Bottom border on last content row seals the card
    const lastContentRow = ins.lastRow;
    for (let col = 1; col <= 2; col++) {
      lastContentRow.getCell(col).border = {
        ...(lastContentRow.getCell(col).border || {}),
        bottom: { style: 'thin', color: { argb: bannerText } },
      };
    }

    // Spacer after card
    const spacer = ins.addRow(['', '']);
    spacer.height = 8;
  };

  // ---------- Cards ----------
  addCard(
    '📥  HOW TO USE',
    COLOR_SEC_BLUE_BG,
    COLOR_SEC_BLUE_TEXT,
    COLOR_GRAY_50,
    [
      ['Step 1', '/list multiadd action:template  →  downloads this file'],
      ['Step 2', 'Replace or delete the three colored example rows (5-7) first'],
      ['Step 3', 'Fill in your own entries below the header (up to 30 total)'],
      ['Step 4', '/list multiadd action:file file:<your.xlsx>  →  preview'],
      ['Step 5', 'Click Confirm to add, or Cancel to abort'],
    ]
  );

  addCard(
    '📋  REQUIRED COLUMNS',
    COLOR_SEC_PURPLE_BG,
    COLOR_SEC_PURPLE_TEXT,
    COLOR_GRAY_50,
    [
      ['name', 'Character name — roster must exist on lostark.bible'],
      ['type', 'Dropdown: black / white / watch'],
      ['reason', 'Why this entry is added (free text)'],
    ]
  );

  addCard(
    '✨  OPTIONAL COLUMNS',
    COLOR_SEC_GREEN_BG,
    COLOR_SEC_GREEN_TEXT,
    COLOR_GRAY_50,
    [
      ['raid', `Dropdown — one of: ${RAIDS.join(', ')}`],
      ['logs', 'URL to lostark.bible logs page — must start with https://'],
      ['image', 'URL to evidence screenshot — upload to Discord first'],
      ['scope', 'Blacklist only: global (shared) or server (this guild)'],
    ]
  );

  addCard(
    '📏  LIMITS & RULES',
    COLOR_SEC_AMBER_BG,
    COLOR_SEC_AMBER_TEXT,
    COLOR_GRAY_50,
    [
      ['Max rows', `${MULTIADD_MAX_ROWS} per file (excluding header)`],
      ['File size', '1 MB max'],
      ['File type', '.xlsx only'],
      ['Preview TTL', '5 minutes, then you must re-upload'],
      ['ilvl gate', 'Characters below ilvl 1700 are rejected'],
      ['Trusted', 'Trusted users (/list trust) are auto-skipped'],
      ['Duplicates', 'Existing entries are reported as Skipped, not re-added'],
    ]
  );

  addCard(
    '🖼️  EVIDENCE IMAGES',
    COLOR_SEC_PINK_BG,
    COLOR_SEC_PINK_TEXT,
    COLOR_GRAY_50,
    [
      ['1.', 'Drag & drop the screenshot into any Discord channel'],
      ['2.', 'Right-click the uploaded image → Copy Link'],
      ['3.', 'Paste the link into the "image" column'],
      ['Note', "Excel doesn't support embedded images — URLs only"],
    ]
  );
}

// ============================================================
// Parser
// ============================================================

// Valid values for enum columns
const VALID_TYPES = new Set(['black', 'white', 'watch']);
const VALID_SCOPES = new Set(['global', 'server']);

/** Coerce an ExcelJS cell value to a plain trimmed string. */
function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  // Hyperlink cell: { text, hyperlink }
  if (typeof value === 'object' && 'hyperlink' in value) {
    return String(value.hyperlink || value.text || '').trim();
  }
  // Rich text cell: { richText: [{ text, ...}, ...] }
  if (typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map((r) => r.text || '').join('').trim();
  }
  // Formula cell: { formula, result }
  if (typeof value === 'object' && 'result' in value) {
    return cellToString(value.result);
  }
  return String(value).trim();
}

/**
 * Parse an uploaded .xlsx file buffer into a list of multiadd row payloads.
 *
 * Header row is detected dynamically by scanning for "name" in column A,
 * so the template can have title banners / subtitles / spacers above the
 * table without breaking the parser.
 *
 * Example rows (reason starts with EXAMPLE_REASON_PREFIX) are silently
 * skipped so users who forget to delete them don't accidentally add
 * ExamplePlayer1/2/3 to the database.
 *
 * Validation rules:
 *   - Required: name, type, reason
 *   - type: must be one of black/white/watch
 *   - scope: optional, must be global/server if present
 *   - logs/image: optional, must start with http(s):// if present
 *   - Rows beyond MULTIADD_MAX_ROWS are rejected with an error
 *   - Fully-blank rows are skipped silently
 *   - Duplicate names within the same file are rejected
 *
 * @param {Buffer} buffer - raw .xlsx file contents
 * @returns {Promise<{ ok: boolean, error?: string, rows: Array, errors: string[] }>}
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
  let acceptedCount = 0;

  // Two-phase iteration:
  //   Phase 1 (headerRowNum === 0): look for the header row by matching
  //     "name" in column A. Skip everything before it.
  //   Phase 2 (headerRowNum > 0): treat subsequent rows as data, validate,
  //     and accept up to MULTIADD_MAX_ROWS.
  let headerRowNum = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    // Phase 1: header detection
    if (headerRowNum === 0) {
      const cellA = cellToString(row.getCell(1).value).toLowerCase();
      if (cellA === 'name') {
        headerRowNum = rowNum;
      }
      return;
    }

    // Phase 2: data row
    if (rowNum <= headerRowNum) return;

    const name = cellToString(row.getCell(1).value);
    const type = cellToString(row.getCell(2).value).toLowerCase();
    const reason = cellToString(row.getCell(3).value);
    const raid = cellToString(row.getCell(4).value);
    const logs = cellToString(row.getCell(5).value);
    const image = cellToString(row.getCell(6).value);
    const scope = cellToString(row.getCell(7).value).toLowerCase();

    // Skip fully-empty rows
    if (!name && !type && !reason) return;

    // Skip template example rows silently (user forgot to delete them)
    if (reason.startsWith(EXAMPLE_REASON_PREFIX)) return;

    // Enforce max rows on ACCEPTED rows only
    if (acceptedCount >= MULTIADD_MAX_ROWS) {
      errors.push(`Row ${rowNum}: exceeds ${MULTIADD_MAX_ROWS}-row limit — skipped.`);
      return;
    }

    // ----- Required field validation -----
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

    // ----- Optional field validation -----
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

    // Intra-file duplicate detection (case-insensitive)
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

  // If we never found a header row, the file is not a valid template
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
