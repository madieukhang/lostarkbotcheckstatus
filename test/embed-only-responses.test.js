import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = [
  'bot/app',
  'bot/handlers',
  'bot/monitor',
  'bot/services/setup',
];

const DATA_ONLY_FILES = new Set([
  'bot/handlers/list/multiadd/attachment.js',
  'bot/handlers/list/services/addExecutor.js',
]);

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) listJsFiles(path, out);
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

function isAllowedContent(line) {
  if (/\bcontent\s*:\s*(?:null|undefined|''|"")(?:,|\s|$)/.test(line)) return true;
  if (/\bcontent\s*:\s*(?:mention|['"]@here['"]|`<@)/.test(line)) return true;
  return false;
}

test('Discord response bodies stay inside embeds', () => {
  const offenders = [];

  for (const root of ROOTS) {
    for (const file of listJsFiles(join(process.cwd(), root))) {
      const relativePath = relative(process.cwd(), file).replaceAll('\\', '/');
      if (DATA_ONLY_FILES.has(relativePath)) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);

      lines.forEach((line, index) => {
        if (/\b(?:replyContent|editContent)\b/.test(line)) {
          offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
          return;
        }
        if (!/\bcontent\s*:/.test(line) || isAllowedContent(line)) return;
        offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      });
    }
  }

  assert.deepEqual(offenders, []);
});
