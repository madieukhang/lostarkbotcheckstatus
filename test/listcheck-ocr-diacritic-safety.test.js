import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { default: config } = await import('../bot/config.js');
const { extractNamesFromImage, clearOcrCache } = await import('../bot/services/list-check/ocr.js');
const { clearNameSuggestionCache } = await import('../bot/services/roster/search.js');

let originalFetch;
let originalKey;

function encodeSuggestions(names) {
  const table = [[]];
  for (const [index, name] of names.entries()) {
    const rowIndex = table.length;
    table[0].push(rowIndex);
    table.push([rowIndex + 1, rowIndex + 2, rowIndex + 3]);
    table.push(name, 'blade', 1700 + index);
  }
  return { type: 'result', result: JSON.stringify(table) };
}

async function runScenario({
  id,
  firstRead,
  suggestions = [],
  refinement,
  repeats = 1,
  invalidSearch = false,
}) {
  const imageUrl = `https://cdn.discordapp.com/${id}.png`;
  const counters = { downloads: 0, searches: 0, gemini: 0 };
  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);
    if (requestedUrl === imageUrl) {
      counters.downloads += 1;
      return new Response(new Uint8Array([31, 32, 33]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      counters.searches += 1;
      return invalidSearch
        ? Response.json({ type: 'error' })
        : Response.json(encodeSuggestions(suggestions));
    }
    if (requestedUrl.includes('generativelanguage.googleapis.com')) {
      counters.gemini += 1;
      const text = counters.gemini === 1
        ? JSON.stringify([firstRead])
        : JSON.stringify({ [firstRead]: refinement });
      return Response.json({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text }] },
        }],
      });
    }
    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  let result;
  for (let index = 0; index < repeats; index += 1) {
    result = await extractNamesFromImage({
      id,
      url: imageUrl,
      contentType: 'image/png',
    }, { refineAmbiguousDiacritics: true });
  }
  return { result, counters };
}

test.beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalKey = config.geminiApiKey;
  config.geminiApiKey = 'fake-gemini-key';
  clearOcrCache();
  clearNameSuggestionCache();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  config.geminiApiKey = originalKey;
  clearOcrCache();
  clearNameSuggestionCache();
});

test('targeted pass retains an already-correct umlaut and refine cache avoids repeat quota', async () => {
  const { result, counters } = await runScenario({
    id: 'correct-umlaut',
    firstRead: 'Crüelfighter',
    suggestions: ['Crüelfighter', 'Crúelfighter'],
    refinement: 'Crüelfighter',
    repeats: 2,
  });

  assert.deepEqual(result, ['Crüelfighter']);
  assert.deepEqual(counters, { downloads: 1, searches: 1, gemini: 2 });
});

test('targeted pass rejects a name outside its same-base candidate allowlist', async () => {
  const { result, counters } = await runScenario({
    id: 'disallowed-mark',
    firstRead: 'Crúelfighter',
    suggestions: ['Crüelfighter', 'Crúelfighter'],
    refinement: 'Crûelfighter',
  });

  assert.deepEqual(result, ['Crúelfighter']);
  assert.equal(counters.gemini, 2);
});

test('targeted pass can resolve an OCR spelling absent from two real same-base identities', async () => {
  const { result, counters } = await runScenario({
    id: 'unknown-mark',
    firstRead: 'Crûelfighter',
    suggestions: ['Crüelfighter', 'Crúelfighter'],
    refinement: 'Crüelfighter',
  });

  assert.deepEqual(result, ['Crüelfighter']);
  assert.equal(counters.gemini, 2);
});

test('one real same-base identity does not spend a second Gemini request', async () => {
  const { result, counters } = await runScenario({
    id: 'single-identity',
    firstRead: 'Zoë',
    suggestions: ['Zoë'],
  });

  assert.deepEqual(result, ['Zoë']);
  assert.equal(counters.gemini, 1);
});

test('unusable Bible search leaves the visual OCR spelling untouched', async () => {
  const { result, counters } = await runScenario({
    id: 'search-unavailable',
    firstRead: 'Zoë',
    invalidSearch: true,
  });

  assert.deepEqual(result, ['Zoë']);
  assert.equal(counters.gemini, 1);
});
