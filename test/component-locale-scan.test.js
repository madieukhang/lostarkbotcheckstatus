import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'locales') continue;
      listJsFiles(path, out);
    } else if (entry.endsWith('.js')) {
      out.push(path);
    }
  }
  return out;
}

test('interactive component labels and placeholders are locale-routed', () => {
  const botDir = join(process.cwd(), 'bot');
  const offenders = [];

  for (const file of listJsFiles(botDir)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = line.match(/\.(setLabel|setPlaceholder)\(\s*(['"`])/);
      if (!match) return;
      if (match[2] === '`' && line.includes('${')) return;
      offenders.push(`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(offenders, []);
});
