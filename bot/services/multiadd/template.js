/**
 * multiaddTemplateService.js
 *
 * Standalone .xlsx template generator + parser for /la-list multiadd.
 * Kept in its own module so it has zero dependencies on config/db/discord,
 * making it trivially importable and testable in isolation. The only
 * internal import is the RAIDS enum, which is a pure data module.
 *
 * The template uses a layered visual layout:
 *   Row 1: gradient title banner (merged)
 *   Row 2: subtitle / quick-start hint (merged)
 *   Row 3: spacer
 *   Row 4: column header (the "real" table header · parser finds this by
 *          scanning for "name" in column A)
 *   Row 5-7: three color-coded example rows (black / white / watch) with
 *          reason prefixed "⚠️ EXAMPLE -" so the parser can safely skip
 *          them if the user forgets to delete.
 *   Row 8: spacer
 *   Row 9-13: blank placeholder rows with subtle borders + zebra stripes
 */

import { RAIDS } from '../../models/Raid.js';
import { buildInstructionsSheet } from './instructionsSheet.js';

// Max rows allowed in /la-list multiadd Excel file (excluding header)
export const MULTIADD_MAX_ROWS = 30;

// Inline-formula form for ExcelJS dropdown data validation.
// Auto-derived from the RAIDS enum in models/Raid.js · single source of truth.
// Current raids (v0.5.14): Act4 Nor/Hard, Kazeros Nor/Hard, Mordum Hard,
// Secra Nor/Hard/NM. Excel limits inline validation formulae to 255 chars,
// so we have plenty of headroom (~10-12 more raids); if it ever grows beyond
// that switch to a named range instead of inline quoted CSV.
const RAID_DROPDOWN_FORMULA = `"${RAIDS.join(',')}"`;

/**
 * Marker prefix for example rows. Parser recognizes this and silently
 * skips the row so forgetful users don't accidentally add "ExampleName"
 * to the database. Keep in sync with buildMultiaddTemplate below.
 */
export const EXAMPLE_REASON_PREFIX = '⚠️ EXAMPLE -';

// ---------- Palette (ARGB with FF alpha) ----------
// Core brand
const COLOR_BLURPLE = 'FF5865F2';
const COLOR_BLURPLE_DARK = 'FF4752C4';
const COLOR_BLURPLE_LIGHT = 'FF7289DA';
const COLOR_BLURPLE_BG = 'FFEEF0FC';
const COLOR_WHITE = 'FFFFFFFF';

// Example row tints · each list type gets its own color family
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

// Instructions sheet section colors · each section gets its own accent
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
 * Build an .xlsx template buffer for /la-list multiadd.
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
  titleCell.value = '📋  LOST ARK BOT · BULK ADD TEMPLATE';
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
      reason: `${EXAMPLE_REASON_PREFIX} Trusted static mate · 6 months (delete this row)`,
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
    // type column (B) · black/white/watch
    sheet.getCell(`B${r}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"black,white,watch"'],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid type',
      error: 'type must be one of: black, white, watch',
    };
    // raid column (D) · enum from models/Raid.js, optional
    sheet.getCell(`D${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [RAID_DROPDOWN_FORMULA],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid raid',
      error: `raid must be one of: ${RAIDS.join(', ')}`,
    };
    // scope column (G) · global/server (blacklist only, optional)
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
  buildInstructionsSheet(wb, {
    colors: {
      COLOR_WHITE,
      COLOR_BLURPLE_BG,
      COLOR_GRAY_50,
      COLOR_GRAY_500,
      COLOR_GRAY_700,
      COLOR_SEC_BLUE_BG,
      COLOR_SEC_BLUE_TEXT,
      COLOR_SEC_PURPLE_BG,
      COLOR_SEC_PURPLE_TEXT,
      COLOR_SEC_GREEN_BG,
      COLOR_SEC_GREEN_TEXT,
      COLOR_SEC_AMBER_BG,
      COLOR_SEC_AMBER_TEXT,
      COLOR_SEC_PINK_BG,
      COLOR_SEC_PINK_TEXT,
    },
    gradientBlurple,
    maxRows: MULTIADD_MAX_ROWS,
    raids: RAIDS,
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
