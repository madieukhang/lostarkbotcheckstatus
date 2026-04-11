/**
 * multiaddTemplate.js
 *
 * Standalone .xlsx template generator for /list multiadd.
 * Kept in its own module so it has zero dependencies on config/db/discord,
 * making it trivially importable and testable in isolation.
 */

// Max rows allowed in /list multiadd Excel file (excluding header)
export const MULTIADD_MAX_ROWS = 30;

// Discord brand colors for template styling (ARGB format with FF alpha)
const COLOR_BLURPLE = 'FF5865F2';   // Discord Blurple — header background
const COLOR_WHITE = 'FFFFFFFF';     // Header text
const COLOR_YELLOW = 'FFFEF3C7';    // Example row background
const COLOR_YELLOW_DARK = 'FFA16207'; // Example row text
const COLOR_GRAY_LIGHT = 'FFF3F4F6'; // Placeholder row stripe
const COLOR_BORDER = 'FFD1D5DB';    // Cell borders
const COLOR_SECTION = 'FFE0E7FF';   // Instructions section header background

/**
 * Return a border object with thin lines on all 4 sides using the template
 * border color. Used for placeholder and example rows in the template.
 */
function borderAll() {
  const side = { style: 'thin', color: { argb: COLOR_BORDER } };
  return { top: side, left: side, bottom: side, right: side };
}

/**
 * Build an .xlsx template buffer for /list multiadd.
 * Returns a Buffer suitable for AttachmentBuilder.
 *
 * Sheet 1 (Entries): 7 columns with Blurple header, dropdown validation
 *                    for type/scope, yellow example row, placeholder rows.
 * Sheet 2 (Instructions): sectioned guide with column descriptions.
 */
export async function buildMultiaddTemplate() {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lost Ark Bot';
  wb.created = new Date();

  // ========== Sheet 1: Entries ==========
  const sheet = wb.addWorksheet('Entries', {
    views: [{ state: 'frozen', ySplit: 1, zoomScale: 110 }],
  });
  sheet.columns = [
    { header: 'name', key: 'name', width: 22 },
    { header: 'type', key: 'type', width: 11 },
    { header: 'reason', key: 'reason', width: 36 },
    { header: 'raid', key: 'raid', width: 18 },
    { header: 'logs', key: 'logs', width: 44 },
    { header: 'image', key: 'image', width: 44 },
    { header: 'scope', key: 'scope', width: 11 },
  ];

  // ---------- Header row styling (Discord Blurple) ----------
  const header = sheet.getRow(1);
  header.height = 26;
  for (let col = 1; col <= 7; col++) {
    const cell = header.getCell(col);
    cell.font = { bold: true, color: { argb: COLOR_WHITE }, size: 11 };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLOR_BLURPLE },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = {
      bottom: { style: 'medium', color: { argb: COLOR_BLURPLE } },
    };
  }

  // Auto-filter dropdowns on header
  sheet.autoFilter = { from: 'A1', to: 'G1' };

  // ---------- Example row (row 2) ----------
  const example = {
    name: 'ExampleName',
    type: 'black',
    reason: '⚠️ DELETE THIS ROW — Example only. Griefing in G6 Aegir HM',
    raid: 'G6 Aegir',
    logs: 'https://lostark.bible/character/NA/ExampleName/logs',
    image: 'https://cdn.discordapp.com/attachments/XXX/YYY/evidence.png',
    scope: 'global',
  };
  sheet.addRow(example);
  const exampleRow = sheet.getRow(2);
  exampleRow.height = 22;
  for (let col = 1; col <= 7; col++) {
    const cell = exampleRow.getCell(col);
    cell.font = { italic: true, color: { argb: COLOR_YELLOW_DARK }, size: 10 };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLOR_YELLOW },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = borderAll();
  }

  // ---------- Placeholder rows (3-7) ----------
  // Empty rows with subtle borders so users see where to type
  for (let r = 3; r <= 7; r++) {
    const row = sheet.getRow(r);
    row.height = 20;
    for (let col = 1; col <= 7; col++) {
      const cell = row.getCell(col);
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      cell.border = borderAll();
      // Subtle zebra striping
      if (r % 2 === 0) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: COLOR_GRAY_LIGHT },
        };
      }
    }
  }

  // ---------- Data validation (dropdowns) ----------
  // Apply to rows 2 through MULTIADD_MAX_ROWS+1 (row 31)
  for (let r = 2; r <= MULTIADD_MAX_ROWS + 1; r++) {
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

  // ========== Sheet 2: Instructions ==========
  const ins = wb.addWorksheet('Instructions', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ins.columns = [
    { width: 20 },
    { width: 72 },
  ];

  // Title row
  ins.addRow(['Lost Ark Bot — /list multiadd Template', '']);
  const titleRow = ins.getRow(1);
  titleRow.height = 28;
  titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: COLOR_WHITE } };
  titleRow.getCell(2).font = { bold: true, size: 14, color: { argb: COLOR_WHITE } };
  for (let col = 1; col <= 2; col++) {
    titleRow.getCell(col).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: COLOR_BLURPLE },
    };
    titleRow.getCell(col).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  }
  ins.mergeCells('A1:B1');

  // Helper to add a section header row
  const addSection = (title) => {
    const row = ins.addRow([title, '']);
    row.height = 22;
    row.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF1E40AF' } };
    for (let col = 1; col <= 2; col++) {
      row.getCell(col).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: COLOR_SECTION },
      };
      row.getCell(col).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    }
    ins.mergeCells(`A${row.number}:B${row.number}`);
  };

  // Helper to add a key/value row
  const addKV = (key, value) => {
    const row = ins.addRow([key, value]);
    row.height = 18;
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
    row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  };

  // Helper to add a plain info row (no key)
  const addInfo = (text) => {
    const row = ins.addRow(['', text]);
    row.height = 16;
    row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
    row.getCell(2).font = { color: { argb: 'FF4B5563' } };
  };

  ins.addRow(['', '']);

  addSection('Required Columns');
  addKV('name', 'Character name — roster must exist on lostark.bible');
  addKV('type', 'black / white / watch — use dropdown');
  addKV('reason', 'Why this entry is added (free text)');

  ins.addRow(['', '']);

  addSection('Optional Columns');
  addKV('raid', 'Raid tag (e.g. G6 Aegir, Thaemine, Kazeros)');
  addKV('logs', 'URL to lostark.bible logs page (must start with https://)');
  addKV('image', 'URL to evidence screenshot (upload to Discord first, copy link)');
  addKV('scope', 'Blacklist only. global = shared, server = this server only');

  ins.addRow(['', '']);

  addSection('Limits');
  addKV('Max rows', `${MULTIADD_MAX_ROWS} (excluding header)`);
  addKV('File size', '1 MB');
  addKV('File type', '.xlsx only');

  ins.addRow(['', '']);

  addSection('Important Notes');
  addInfo('• Delete the example row (yellow highlighted) before uploading.');
  addInfo('• Blank rows are ignored — safe to leave space at the bottom.');
  addInfo('• Trusted users (in /list trust) are skipped automatically.');
  addInfo('• Duplicate entries are reported in the summary but not re-added.');
  addInfo('• Characters with ilvl < 1700 are rejected.');
  addInfo('• Rows with invalid data are listed in errors, valid rows still process.');

  ins.addRow(['', '']);

  addSection('How to Host Evidence Images');
  addInfo('1. Drag & drop the screenshot into any Discord channel.');
  addInfo('2. Right-click the uploaded image → Copy Link.');
  addInfo('3. Paste the link into the "image" column.');

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// Valid values for enum columns
const VALID_TYPES = new Set(['black', 'white', 'watch']);
const VALID_SCOPES = new Set(['global', 'server']);

/**
 * Coerce an ExcelJS cell value to a plain trimmed string.
 * Handles: strings, numbers, hyperlinks ({ text, hyperlink }), rich text
 * ({ richText: [...] }), nulls, and formula results.
 */
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

  // Prefer the sheet named "Entries" (from our template), fallback to the first
  const sheet = wb.getWorksheet('Entries') || wb.worksheets[0];
  if (!sheet) {
    return { ok: false, error: 'No worksheet found in file.', rows: [], errors: [] };
  }

  const rows = [];
  const errors = [];
  const seenNames = new Set(); // for intra-file duplicate detection (case-insensitive)
  let acceptedCount = 0;

  // Iterate rows starting from row 2 (row 1 is header)
  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return; // header

    const name = cellToString(row.getCell(1).value);
    const type = cellToString(row.getCell(2).value).toLowerCase();
    const reason = cellToString(row.getCell(3).value);
    const raid = cellToString(row.getCell(4).value);
    const logs = cellToString(row.getCell(5).value);
    const image = cellToString(row.getCell(6).value);
    const scope = cellToString(row.getCell(7).value).toLowerCase();

    // Skip fully-empty rows (no name/type/reason — user's intentional blank)
    if (!name && !type && !reason) return;

    // Enforce max rows on ACCEPTED rows only (errors after limit are suppressed
    // to avoid a 31-row file producing 30 valid + 1 rejection)
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

    // Scope only meaningful for blacklist; warn if set for white/watch but still accept
    if (scope && type !== 'black') {
      errors.push(`Row ${rowNum}: scope is ignored for type "${type}" (blacklist only).`);
      // fall through — don't reject, just strip the scope
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
      scope: type === 'black' ? scope : '', // strip scope for non-blacklist
    });
    acceptedCount++;
  });

  return { ok: true, rows, errors };
}

