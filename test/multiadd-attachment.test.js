import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMultiaddAttachment } from '../bot/handlers/list/multiadd/attachment.js';

test('multiadd attachment validation table keeps first-failure priority', () => {
  assert.match(validateMultiaddAttachment(null, 'en'), /attach|required/i);
  assert.match(
    validateMultiaddAttachment({ name: 'entries.csv', size: 2 * 1024 * 1024 }, 'en'),
    /xlsx/i
  );
  assert.match(
    validateMultiaddAttachment({ name: 'entries.xlsx', size: 2 * 1024 * 1024 }, 'en'),
    /1 MB|large/i
  );
  assert.equal(
    validateMultiaddAttachment({ name: 'entries.xlsx', size: 1024 }, 'en'),
    null
  );
});
