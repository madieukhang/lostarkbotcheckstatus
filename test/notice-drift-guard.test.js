import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Simple notices name a kind; only the rich cards left out of the notice
// redesign keep a raw severity. A new simple notice written with `severity`
// fails here, so the two families cannot drift apart again.
const RICH_CARD_FILES = new Set([
  'bot/handlers/list/duplicate-ui.js',
  'bot/handlers/list/enrich/ui.js',
  'bot/handlers/list/evidence/broadcastButton.js',
  'bot/handlers/list/evidence/entryButton.js',
  'bot/handlers/list/helpers.js',
  'bot/handlers/list/notes/addedCard.js',
  'bot/handlers/list/services/addExecutor.js',
  'bot/handlers/list/services/approvals.js',
  'bot/handlers/list/trust/index.js',
  'bot/handlers/roster/hiddenRoster.js',
  'bot/handlers/setup/guildSetup.js',
  'bot/utils/imageRehost.js',
  'bot/utils/scanProgressEmbed.js',
]);

// The builder itself defines and maps severities.
const BUILDER_FILE = 'bot/utils/alertEmbed.js';

const REMOVED_NOTICE_HELPERS = /\b(?:buildNoticeEmbed|replyNotice|editNotice|updateNotice|editNoticeAfterSavedWrite)\b/;
const SEVERITY_OPTION = /\bseverity\s*:/;

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listJsFiles(path, out);
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

function sourceFiles(root) {
  return listJsFiles(join(process.cwd(), root)).map((file) => ({
    path: relative(process.cwd(), file).replaceAll('\\', '/'),
    lines: readFileSync(file, 'utf8').split(/\r?\n/),
  }));
}

// Comment lines may name the option while describing a rich card.
const isComment = (line) => /^\s*(?:\/\/|\*|\/\*)/.test(line);

test('a severity option appears only in the rich-card files', () => {
  const offenders = [];
  const filesWithSeverity = new Set();
  for (const { path, lines } of sourceFiles('bot')) {
    if (path === BUILDER_FILE) continue;
    lines.forEach((line, index) => {
      if (isComment(line) || !SEVERITY_OPTION.test(line)) return;
      filesWithSeverity.add(path);
      if (!RICH_CARD_FILES.has(path)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(offenders, []);
  // A rich-card file that no longer sets a severity leaves the list stale.
  assert.deepEqual([...RICH_CARD_FILES].filter((path) => !filesWithSeverity.has(path)), []);
});

test('no source or test file uses a retired notice helper', () => {
  const users = [];
  for (const { path, lines } of [...sourceFiles('bot'), ...sourceFiles('test')]) {
    if (path === 'test/notice-drift-guard.test.js') continue;
    lines.forEach((line, index) => {
      if (REMOVED_NOTICE_HELPERS.test(line)) users.push(`${path}:${index + 1}`);
    });
  }
  assert.deepEqual(users, []);
});
