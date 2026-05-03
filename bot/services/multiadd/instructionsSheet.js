export function buildInstructionsSheet(wb, options) {
  const {
    colors,
    gradientBlurple,
    maxRows,
    raids,
  } = options;
  const {
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
  } = colors;

  const ins = wb.addWorksheet('Instructions', {
    views: [{ state: 'frozen', ySplit: 3, zoomScale: 110 }],
    properties: { defaultRowHeight: 18 },
  });

  ins.getColumn(1).width = 22;
  ins.getColumn(2).width = 72;

  ins.mergeCells('A1:B1');
  const titleCell = ins.getCell('A1');
  titleCell.value = '📖  INSTRUCTIONS — /la-list multiadd';
  titleCell.font = {
    name: 'Segoe UI Semibold',
    bold: true,
    size: 16,
    color: { argb: COLOR_WHITE },
  };
  titleCell.fill = gradientBlurple();
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ins.getRow(1).height = 42;

  ins.mergeCells('A2:B2');
  const subtitleCell = ins.getCell('A2');
  subtitleCell.value = 'How to fill out and upload the bulk add template';
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
  ins.getRow(3).height = 6;

  const addCard = (title, bannerBg, bannerText, contentBg, items) => {
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

    const lastContentRow = ins.lastRow;
    for (let col = 1; col <= 2; col++) {
      lastContentRow.getCell(col).border = {
        ...(lastContentRow.getCell(col).border || {}),
        bottom: { style: 'thin', color: { argb: bannerText } },
      };
    }

    const spacer = ins.addRow(['', '']);
    spacer.height = 8;
  };

  addCard(
    '📥  HOW TO USE',
    COLOR_SEC_BLUE_BG,
    COLOR_SEC_BLUE_TEXT,
    COLOR_GRAY_50,
    [
      ['Step 1', '/la-list multiadd action:template  →  downloads this file'],
      ['Step 2', 'Replace or delete the three colored example rows (5-7) first'],
      ['Step 3', 'Fill in your own entries below the header (up to 30 total)'],
      ['Step 4', '/la-list multiadd action:file file:<your.xlsx>  →  preview'],
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
      ['raid', `Dropdown — one of: ${raids.join(', ')}`],
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
      ['Max rows', `${maxRows} per file (excluding header)`],
      ['File size', '1 MB max'],
      ['File type', '.xlsx only'],
      ['Preview TTL', '5 minutes, then you must re-upload'],
      ['ilvl gate', 'Characters below ilvl 1700 are rejected'],
      ['Trusted', 'Trusted users (/la-list trust) are auto-skipped'],
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
