import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  bootstrapEmojiFolder,
  getEmojiAssetDirs,
} from '../bot/services/discord/emoji-bootstrap.js';

test('LoaLogs emoji bootstrap resolves class icons from the repo assets folder', () => {
  const { classIconsDir } = getEmojiAssetDirs();
  assert.ok(fs.existsSync(path.join(classIconsDir, 'bard.png')));
  assert.doesNotMatch(classIconsDir.replace(/\\/g, '/'), /\/bot\/assets\//);
});

test('LoaLogs emoji bootstrap uploads canonical art once and reuses it for aliases', async () => {
  const { classIconsDir } = getEmojiAssetDirs();
  const postedNames = [];
  const client = {
    application: { id: 'app-1' },
    rest: {
      get: async () => [],
      delete: async () => undefined,
      post: async (_route, { body }) => {
        postedNames.push(body.name);
        return { id: 'emoji-1', name: body.name };
      },
    },
  };
  const emojiMap = {};
  const result = await bootstrapEmojiFolder(client, {
    namespace: 'test-emoji',
    iconsDir: classIconsDir,
    emojiMap,
    resolveDisplayKey: (fileBase) => (
      ['soulmaster', 'force_master'].includes(fileBase) ? fileBase : null
    ),
    aliasGroups: [['soulmaster', 'force_master']],
    mutationDelayMs: 0,
  });

  assert.equal(postedNames.length, 1);
  assert.match(postedNames[0], /^soulmaster_[0-9a-f]{6}$/);
  assert.equal(result.uploaded, 1);
  assert.equal(result.aliasResolved, 1);
  assert.equal(result.total, 2);
  assert.equal(emojiMap.soulmaster, emojiMap.force_master);
});
