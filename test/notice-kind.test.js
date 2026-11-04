import test from 'node:test';
import assert from 'node:assert/strict';

import { AlertSeverity, NoticeKind, buildAlertEmbed } from '../bot/utils/alertEmbed.js';
import { COLORS } from '../bot/utils/ui.js';
import { editAlertAfterSavedWrite } from '../bot/utils/interactionReplies.js';

const EXPECTED = [
  [NoticeKind.GUARD, '🔒', COLORS.warning],
  [NoticeKind.EXPIRED, '⌛', COLORS.muted],
  [NoticeKind.INPUT, '✏️', COLORS.warning],
  [NoticeKind.EMPTY, '🔍', COLORS.info],
  [NoticeKind.BUSY, '🚦', COLORS.warning],
  [NoticeKind.FAILURE, '❌', COLORS.danger],
  [NoticeKind.PROGRESS, '⏳', COLORS.info],
  [NoticeKind.DONE, '✅', COLORS.success],
  [NoticeKind.PARTIAL, '⚠️', COLORS.warning],
];

test('each notice kind gives its icon and colour', () => {
  assert.equal(Object.keys(NoticeKind).length, EXPECTED.length);
  for (const [kind, icon, color] of EXPECTED) {
    const json = buildAlertEmbed({ kind, title: 'T' }).toJSON();
    assert.equal(json.title, `${icon}  T`, kind);
    assert.equal(json.color, color, kind);
  }
});

test('a tip renders as the footer with its markdown stripped', () => {
  const json = buildAlertEmbed({ kind: NoticeKind.INPUT, title: 'T', tip: 'Run `/la-check` **now**' }).toJSON();
  assert.equal(json.footer.text, '💡 Run /la-check now');
});

test('a tip and a footer on one notice throw', () => {
  assert.throws(() => buildAlertEmbed({ kind: NoticeKind.DONE, title: 'T', tip: 'a', footer: 'b' }));
});

test('a kind notice carries a timestamp', () => {
  assert.ok(buildAlertEmbed({ kind: NoticeKind.EMPTY, title: 'T' }).toJSON().timestamp);
});

test('the severity path of rich cards renders as before', () => {
  const json = buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: '⛔',
    color: COLORS.danger,
    title: 'X',
    footer: 'f',
  }).toJSON();
  assert.equal(json.title, '⛔  X');
  assert.equal(json.color, COLORS.danger);
  assert.equal(json.footer.text, 'f');
  assert.equal(buildAlertEmbed({ severity: AlertSeverity.WARNING, title: 'W' }).toJSON().title, '⚠️  W');
});

test('editAlertAfterSavedWrite answers with a done notice, clears components and swallows a failed reply', async () => {
  const payloads = [];
  await editAlertAfterSavedWrite({ editReply: async (payload) => payloads.push(payload) }, { title: 'Saved' });
  assert.equal(payloads[0].embeds[0].toJSON().color, COLORS.success);
  assert.deepEqual(payloads[0].components, []);
  await editAlertAfterSavedWrite({ editReply: async () => { throw new Error('gone'); } }, { title: 'Saved' });
});

test('a long detail field is cut to the field limit instead of throwing', () => {
  const json = buildAlertEmbed({
    kind: NoticeKind.FAILURE,
    title: 'T',
    fields: [{ name: '🧾 Chi tiết', value: `\`${'x'.repeat(2000)}\`` }],
  }).toJSON();
  assert.equal(json.fields[0].value.length, 1024);
});
