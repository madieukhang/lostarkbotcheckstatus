import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCleanupVolumeBucket,
  buildCleanupNoticeEmbed,
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
  assert.equal(buildCleanupNoticeEmbed(0, 'en'), null);
});

test('the notice renders the count and comes from the right pool', () => {
  for (const [deleted, bucket] of [[3, 'trivial'], [12, 'normal'], [40, 'heavy']]) {
    const json = buildCleanupNoticeEmbed(deleted, 'en').toJSON();
    assert.match(json.description, new RegExp(`\\b${deleted}\\b`), 'count must appear');
    assert.doesNotMatch(json.description, /\{n\}/, 'placeholder must be interpolated');
    const pool = TRANSLATIONS.en.dialogue.cleanupNotice[bucket].variants;
    assert.ok(
      pool.some((v) => v.replace('{n}', String(deleted)) === json.description),
      `description should come from the ${bucket} pool`
    );
  }
});

test('the notice renders in the guild language', () => {
  for (const lang of ['en', 'vi', 'jp']) {
    const json = buildCleanupNoticeEmbed(9, lang).toJSON();
    const pool = TRANSLATIONS[lang].dialogue.cleanupNotice.normal.variants;
    assert.ok(pool.some((v) => v.replace('{n}', '9') === json.description), `${lang} pool`);
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

test('a successful post reports true and sends exactly one embed', async () => {
  const payloads = [];
  const channel = { async send(payload) { payloads.push(payload); } };
  assert.equal(await postCleanupNotice(channel, 7, 'en'), true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].embeds.length, 1);
});
