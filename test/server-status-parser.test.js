import test from 'node:test';
import assert from 'node:assert/strict';

import { parseServerStatuses, STATUS } from '../bot/monitor/serverStatus.js';

const silentLogger = { log() {}, error() {} };
const rowClass = 'ags-ServerStatus-content-responses-response-server';
const nameClass = 'ags-ServerStatus-content-responses-response-server-name';
const statusClass = 'ags-ServerStatus-content-responses-response-server-status';

function fixture({ ariaLabel = null, modifier = '' } = {}) {
  const aria = ariaLabel === null ? '' : ` aria-label="${ariaLabel}"`;
  return `
    <div class="${rowClass}">
      <div class="${statusClass}${modifier ? ` ${statusClass}--${modifier}` : ''}"></div>
      <div class="${nameClass}"${aria}>Thaemine</div>
    </div>
  `;
}

test('Thaemine busy/full aria labels are definitive online states', () => {
  for (const ariaLabel of ['Thaemine is busy', 'Thaemine is full']) {
    const statuses = parseServerStatuses(
      fixture({ ariaLabel }),
      ['Thaemine'],
      { logger: silentLogger },
    );
    assert.equal(statuses.get('Thaemine'), STATUS.ONLINE);
  }
});

test('unknown Thaemine aria text falls through to the CSS modifier', () => {
  const statuses = parseServerStatuses(
    fixture({ ariaLabel: 'Thaemine status unavailable', modifier: 'busy' }),
    ['Thaemine'],
    { logger: silentLogger },
  );
  assert.equal(statuses.get('Thaemine'), STATUS.ONLINE);
});

test('Thaemine base status class without a modifier means offline', () => {
  const statuses = parseServerStatuses(fixture(), ['Thaemine'], { logger: silentLogger });
  assert.equal(statuses.get('Thaemine'), STATUS.OFFLINE);
});

test('a maintenance class wins over an offline aria label, so the wrench is never read as offline', () => {
  const lines = [];
  const statuses = parseServerStatuses(
    fixture({ ariaLabel: 'Thaemine is offline', modifier: 'maintenance' }),
    ['Thaemine'],
    { logger: { log: (line) => lines.push(line), error() {} } },
  );
  assert.equal(statuses.get('Thaemine'), STATUS.MAINTENANCE);
  // Both signals reach the log, so a real maintenance shows how the page marks it.
  assert.ok(lines.some((line) => line.includes('"Thaemine is offline"') && line.includes('--maintenance')), lines.join('\n'));
});

test('an online aria label still wins over a stale offline class', () => {
  const statuses = parseServerStatuses(
    fixture({ ariaLabel: 'Thaemine is online' }),
    ['Thaemine'],
    { logger: silentLogger },
  );
  assert.equal(statuses.get('Thaemine'), STATUS.ONLINE);
});
