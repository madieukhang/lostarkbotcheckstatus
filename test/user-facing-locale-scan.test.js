import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = [
  'bot/handlers',
  'bot/monitor',
  'bot/services/setup',
  'bot/utils',
];

const EXCLUDED_FILES = new Set([
  // Internal archive/audit metadata, never shown in a command response.
  'bot/utils/imageRehost.js',
  // The shared builders necessarily receive already-localized strings.
  'bot/utils/alertEmbed.js',
  'bot/utils/artistVoice.js',
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

function isAllowedLiteral(line) {
  if (line.includes('t(')) return true;
  if (/\b(?:content|description|footer)\s*:\s*(['"])\1/.test(line)) return true;
  if (/\bcontent\s*:\s*(?:null|undefined|'@here'|"@here")/.test(line)) return true;
  // Dynamic-only templates (icons, names, page counters) do not carry prose.
  // Keep ternaries with quoted words visible to the gate: those are dialogue.
  if (line.includes('`')) {
    const expressions = [...line.matchAll(/\$\{([^{}]*)\}/g)].map((match) => match[1]);
    const expressionHasCopy = expressions.some((expression) => /['"][^'"]*\p{L}/u.test(expression));
    const withoutExpressions = line.replace(/\$\{[^{}]*\}/g, '');
    const templateBody = withoutExpressions.match(/`([^`]*)`/)?.[1] || '';
    if (!expressionHasCopy && !/\p{L}/u.test(templateBody)) return true;
  }
  return false;
}

test('user-facing dialogue is routed through the EN/VI/JP locale layer', () => {
  const offenders = [];
  const sinkLiteral = /\.set(?:Title|Description|Footer|Label|Placeholder)\(\s*[`'"]/;
  const payloadLiteral = /\b(?:title|description|footer|content)\s*:\s*[`'"]/;

  for (const root of ROOTS) {
    for (const file of listJsFiles(join(process.cwd(), root))) {
      const relativePath = relative(process.cwd(), file).replaceAll('\\', '/');
      if (EXCLUDED_FILES.has(relativePath)) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!sinkLiteral.test(line) && !payloadLiteral.test(line)) return;
        if (isAllowedLiteral(line)) return;
        offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      });
    }
  }

  assert.deepEqual(offenders, []);
});
