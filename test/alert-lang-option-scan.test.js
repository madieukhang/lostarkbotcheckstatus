import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The alert builders read a fixed set of option keys, and the notice helpers
// hand every key they do not know to the Discord payload, so a `lang` option at
// these calls either does nothing or leaks into the reply. The language reaches
// the text through t(); buildStrongholdScanLimitEmbed(active, lang) is not
// listed because its language is a positional argument.
// editAlertFn, buildNoticeEmbedFn and editNoticeFn are the injected stand-ins
// for editAlert, buildNoticeEmbed and editNotice.
const CALLEES = [
  'buildAlertEmbed',
  'buildNoticeEmbed',
  'replyAlert',
  'editAlert',
  'updateAlert',
  'followUpAlert',
  'replyNotice',
  'editNotice',
  'updateNotice',
  'editNoticeAfterSavedWrite',
  'editAlertFn',
  'buildNoticeEmbedFn',
  'editNoticeFn',
];

const CALL = new RegExp(`(?<![\\w$])(${CALLEES.join('|')})\\s*\\(`, 'g');
const REGEX_AFTER_PUNCTUATION = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_AFTER_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listJsFiles(path, out);
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

// Blank comments, string and regex contents and template text, keeping `${ }`
// expressions, so a brace or comma that is only text never reaches the call
// parser. Offsets and line breaks stay unchanged.
function maskSource(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const startsRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1;
    const before = out.slice(Math.max(0, k - 12), k + 1).join('');
    return before === '' || REGEX_AFTER_PUNCTUATION.test(before) || REGEX_AFTER_KEYWORD.test(before);
  };

  function skipString(at) {
    let k = at + 1;
    while (k < source.length && source[k] !== source[at] && source[k] !== '\n') {
      k += source[k] === '\\' ? 2 : 1;
    }
    blank(at + 1, k);
    return k + 1;
  }

  function skipRegex(at) {
    let k = at + 1;
    let inClass = false;
    while (k < source.length && source[k] !== '\n') {
      if (source[k] === '\\') {
        k += 2;
        continue;
      }
      if (source[k] === '[') inClass = true;
      else if (source[k] === ']') inClass = false;
      else if (source[k] === '/' && !inClass) break;
      k += 1;
    }
    blank(at + 1, k);
    return k + 1;
  }

  function skipTemplate(at) {
    let k = at + 1;
    let textFrom = k;
    while (k < source.length && source[k] !== '`') {
      if (source[k] === '\\') {
        k += 2;
      } else if (source[k] === '$' && source[k + 1] === '{') {
        blank(textFrom, k);
        k = scanCode(k + 2, true);
        textFrom = k;
      } else {
        k += 1;
      }
    }
    blank(textFrom, k);
    return k + 1;
  }

  function scanCode(from, untilBrace) {
    let depth = 0;
    let k = from;
    while (k < source.length) {
      const ch = source[k];
      if (ch === '/' && source[k + 1] === '/') {
        const end = source.indexOf('\n', k);
        const stop = end === -1 ? source.length : end;
        blank(k, stop);
        k = stop;
      } else if (ch === '/' && source[k + 1] === '*') {
        const end = source.indexOf('*/', k + 2);
        const stop = end === -1 ? source.length : end + 2;
        blank(k, stop);
        k = stop;
      } else if (ch === "'" || ch === '"') {
        k = skipString(k);
      } else if (ch === '`') {
        k = skipTemplate(k);
      } else if (ch === '/' && startsRegex(k)) {
        k = skipRegex(k);
      } else {
        if (ch === '{') depth += 1;
        if (ch === '}') {
          if (untilBrace && depth === 0) return k + 1;
          depth -= 1;
        }
        k += 1;
      }
    }
    return k;
  }

  scanCode(0, false);
  return out.join('');
}

function matchingClose(masked, open) {
  let depth = 0;
  for (let k = open; k < masked.length; k += 1) {
    if ('([{'.includes(masked[k])) depth += 1;
    else if (')]}'.includes(masked[k])) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

// [from, to) ranges of the comma-separated items between two brackets.
function topLevelItems(masked, open, close) {
  const items = [];
  let depth = 0;
  let from = open + 1;
  for (let k = open + 1; k < close; k += 1) {
    if ('([{'.includes(masked[k])) depth += 1;
    else if (')]}'.includes(masked[k])) depth -= 1;
    else if (masked[k] === ',' && depth === 0) {
      items.push([from, k]);
      from = k + 1;
    }
  }
  items.push([from, close]);
  return items.filter(([a, b]) => masked.slice(a, b).trim() !== '');
}

// Finds a top-level `lang` key in an object literal passed straight to one of
// CALLEES. Options built in a variable and passed later are not seen.
function findLangOptionKeys(source) {
  const masked = maskSource(source);
  const calls = [];
  const found = [];
  for (const match of masked.matchAll(CALL)) {
    const open = match.index + match[0].length - 1;
    const close = matchingClose(masked, open);
    if (close === -1) continue;
    calls.push(match[1]);
    for (const [argFrom, argTo] of topLevelItems(masked, open, close)) {
      const objectOpen = argFrom + masked.slice(argFrom, argTo).search(/\S/);
      if (masked[objectOpen] !== '{') continue;
      const objectClose = matchingClose(masked, objectOpen);
      for (const [from, to] of topLevelItems(masked, objectOpen, objectClose)) {
        const keyAt = from + masked.slice(from, to).search(/\S/);
        if (/^(?:lang|'lang'|"lang")\s*(?:[:=,}]|$)/.test(source.slice(keyAt, to + 1))) {
          found.push({ callee: match[1], line: source.slice(0, keyAt).split('\n').length });
        }
      }
    }
  }
  return { calls, found };
}

test('alert and notice calls do not pass a lang option', () => {
  const offenders = [];
  const inspected = new Set();

  for (const file of listJsFiles(join(process.cwd(), 'bot'))) {
    const relativePath = relative(process.cwd(), file).replaceAll('\\', '/');
    const { calls, found } = findLangOptionKeys(readFileSync(file, 'utf8'));
    calls.forEach((callee) => inspected.add(callee));
    found.forEach(({ callee, line }) => offenders.push(`${relativePath}:${line}: ${callee}`));
  }

  assert.deepEqual([...inspected].sort(), [...CALLEES].sort(), 'every listed callee is still scanned');
  assert.deepEqual(offenders, []);
});
