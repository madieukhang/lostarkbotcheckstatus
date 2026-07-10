import test from 'node:test';
import assert from 'node:assert/strict';

const { buildAlertEmbed, AlertSeverity } = await import('../bot/utils/alertEmbed.js');

test('shared alert embeds avoid repeated Artist branding and preserve operational footers', () => {
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

  assert.equal(defaultEmbed.author, undefined);
  assert.equal(defaultEmbed.footer, undefined);
  assert.equal(explicitFooter.author, undefined);
  assert.equal(explicitFooter.footer.text, 'Source: lostark.bible');
});
