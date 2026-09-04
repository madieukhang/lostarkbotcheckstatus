import fs from 'node:fs';
import path from 'node:path';

function readArg(name) {
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePositiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function resolveMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new Error(`Unsupported image extension: ${extension || '(none)'}`);
  return mimeType;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

const defaultImagePath = path.resolve('data', 'benchmarks', 'ocr-party-lobby.png');
const imagePath = path.resolve(readArg('image') || defaultImagePath);
const expectedArg = readArg('expected');
const expectedPath = expectedArg
  ? path.resolve(expectedArg)
  : imagePath.replace(/\.[^.]+$/, '.expected.json');
const runs = parsePositiveInt(readArg('runs'), 1, '--runs');
const tokenCap = parsePositiveInt(readArg('tokens'), 768, '--tokens');

if (!fs.existsSync(imagePath)) {
  throw new Error(`Benchmark image not found: ${imagePath}`);
}
if (runs > 20) throw new Error('--runs must be 20 or fewer to avoid accidental quota spikes.');

process.env.GEMINI_MAX_OUTPUT_TOKENS = String(tokenCap);
const [{ extractNamesFromImage, clearOcrCache }, { default: config }] = await Promise.all([
  import('./bot/services/list-check/ocr.js'),
  import('./bot/config.js'),
]);

const mimeType = resolveMimeType(imagePath);
const imageBase64 = fs.readFileSync(imagePath).toString('base64');
const imageUrl = `data:${mimeType};base64,${imageBase64}`;
const expectedNames = fs.existsSync(expectedPath)
  ? JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
  : null;
if (expectedNames !== null && !Array.isArray(expectedNames)) {
  throw new Error(`Expected-name file must contain a JSON array: ${expectedPath}`);
}

console.log(
  `[benchmark] image=${imagePath} runs=${runs} maxOutputTokens=${config.geminiMaxOutputTokens}`
  + ` expected=${expectedNames ? expectedPath : 'none'}`,
);

const results = [];
for (let run = 1; run <= runs; run += 1) {
  clearOcrCache();
  const startedAt = Date.now();
  try {
    const names = await extractNamesFromImage({
      id: `ocr-benchmark-${run}`,
      url: imageUrl,
      contentType: mimeType,
    });
    const exact = expectedNames === null
      ? null
      : JSON.stringify(names) === JSON.stringify(expectedNames);
    const result = { run, elapsedMs: Date.now() - startedAt, exact, names };
    results.push(result);
    console.log(`[benchmark] result=${JSON.stringify(result)}`);
  } catch (error) {
    const result = {
      run,
      elapsedMs: Date.now() - startedAt,
      exact: false,
      error: error?.message || String(error),
    };
    results.push(result);
    console.error(`[benchmark] result=${JSON.stringify(result)}`);
  }
}

const successful = results.filter((result) => Array.isArray(result.names));
const exactMatches = results.filter((result) => result.exact === true).length;
console.log(
  `[benchmark] summary success=${successful.length}/${runs}`
  + ` exact=${expectedNames ? `${exactMatches}/${runs}` : 'not-checked'}`
  + ` medianMs=${median(successful.map((result) => result.elapsedMs))}`,
);
