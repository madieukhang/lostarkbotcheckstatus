import test from 'node:test';
import assert from 'node:assert/strict';

const { buildAlertEmbed, AlertSeverity } = await import('../bot/utils/alertEmbed.js');

test('shared alert embeds carry the Artist identity without replacing operational footers', () => {
  const defaultEmbed = buildAlertEmbed({
    severity: AlertSeverity.INFO,
    title: 'A small update',
    description: 'Everything is ready.',
  }).toJSON();
  const explicitFooter = buildAlertEmbed({
    severity: AlertSeverity.INFO,
    title: 'A small update',
    footer: 'Source: lostark.bible',
  }).toJSON();

  assert.equal(defaultEmbed.author.name, 'Artist · LoaLogs');
  assert.match(defaultEmbed.footer.text, /Artist/i);
  assert.equal(explicitFooter.author.name, 'Artist · LoaLogs');
  assert.equal(explicitFooter.footer.text, 'Source: lostark.bible');
});
