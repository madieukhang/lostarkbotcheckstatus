import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_CHECK_CLEANUP_NOTICE_TTL_MS,
  resolveCleanupVolumeBucket,
  buildCleanupNoticeContent,
  postCleanupNotice,
} from '../bot/services/setup/cleanupNotice.js';
import { TRANSLATIONS } from '../bot/locales/index.js';

test('volume buckets scale with how much was cleared', () => {
  assert.equal(resolveCleanupVolumeBucket(1), 'trivial');
  assert.equal(resolveCleanupVolumeBucket(5), 'trivial');
  assert.equal(resolveCleanupVolumeBucket(6), 'normal');
  assert.equal(resolveCleanupVolumeBucket(20), 'normal');
  assert.equal(resolveCleanupVolumeBucket(21), 'heavy');
});

test('an empty sweep says nothing at all', () => {
  // A nightly "there was nothing to clean" is noise in a quiet channel.
  assert.equal(resolveCleanupVolumeBucket(0), null);
  assert.equal(resolveCleanupVolumeBucket(-3), null);
  assert.equal(buildCleanupNoticeContent(0, 'en'), null);
});

test('the notice renders the count and comes from the right pool', () => {
  for (const [deleted, bucket] of [[3, 'trivial'], [12, 'normal'], [40, 'heavy']]) {
    const content = buildCleanupNoticeContent(deleted, 'en');
    assert.match(content, new RegExp(`\\b${deleted}\\b`), 'count must appear');
    assert.doesNotMatch(content, /\{n\}/, 'placeholder must be interpolated');
    const pool = TRANSLATIONS.en.dialogue.cleanupNotice[bucket].variants;
    assert.ok(
      pool.some((v) => v.replace('{n}', String(deleted)) === content),
      `content should come from the ${bucket} pool`
    );
  }
});

test('the notice renders in the guild language', () => {
  for (const lang of ['en', 'vi', 'jp']) {
    const content = buildCleanupNoticeContent(9, lang);
    const pool = TRANSLATIONS[lang].dialogue.cleanupNotice.normal.variants;
    assert.ok(pool.some((v) => v.replace('{n}', '9') === content), `${lang} pool`);
  }
});

test('posting is skipped entirely when nothing was deleted', async () => {
  let sent = 0;
  const channel = { async send() { sent += 1; } };
  assert.equal(await postCleanupNotice(channel, 0, 'en'), false);
  assert.equal(sent, 0);
});

test('a send failure is swallowed so a good sweep is not reported as failed', async () => {
  const warnings = [];
  const channel = { async send() { throw new Error('Missing Permissions'); } };
  const posted = await postCleanupNotice(channel, 7, 'en', {
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  assert.equal(posted, false);
  assert.equal(warnings.length, 1);
});

test('a successful post sends one plain message and deletes it after five minutes', async () => {
  const payloads = [];
  let scheduled = null;
  let delay = null;
  let deleted = 0;
  let unrefCalls = 0;
  const channel = {
    async send(payload) {
      payloads.push(payload);
      return {
        async delete() { deleted += 1; },
      };
    },
  };
  assert.equal(await postCleanupNotice(channel, 7, 'en', {
    setTimeoutFn(callback, ms) {
      scheduled = callback;
      delay = ms;
      return { unref() { unrefCalls += 1; } };
    },
  }), true);
  assert.equal(payloads.length, 1);
  assert.equal(typeof payloads[0].content, 'string');
  assert.equal('embeds' in payloads[0], false);
  assert.equal(delay, AUTO_CHECK_CLEANUP_NOTICE_TTL_MS);
  assert.equal(unrefCalls, 1);

  scheduled();
  await Promise.resolve();
  assert.equal(deleted, 1);
});
