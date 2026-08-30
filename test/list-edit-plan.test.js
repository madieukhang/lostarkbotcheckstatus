import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildListEditPlan,
  buildScopeConflictQuery,
  shouldApplyListEditImmediately,
} from '../bot/handlers/list/edit/plan.js';

function makeEntry(overrides = {}) {
  return {
    _id: 'a'.repeat(24),
    name: 'Mainchar',
    reason: 'Old reason',
    raid: '',
    scope: 'global',
    allCharacters: ['Existingalt'],
    ...overrides,
  };
}

test('list edit plan resolves the final blacklist scope before approval routing', () => {
  const plan = buildListEditPlan({
    existing: makeEntry({ scope: undefined }),
    currentType: 'white',
    newType: 'black',
    guildDefaultScope: 'server',
  });

  assert.equal(plan.targetType, 'black');
  assert.equal(plan.targetScope, 'server');
  assert.equal(plan.isTypeChange, true);
  assert.equal(plan.isScopeChange, false);
  assert.equal(plan.changes.length, 1);
  assert.equal(shouldApplyListEditImmediately({
    isOwner: false,
    isApprover: false,
    targetType: plan.targetType,
    targetScope: plan.targetScope,
  }), true);
});

test('list edit plan distinguishes requested no-ops from missing options', () => {
  const noOptions = buildListEditPlan({
    existing: makeEntry({ scope: 'server' }),
    currentType: 'black',
  });
  const sameScope = buildListEditPlan({
    existing: makeEntry({ scope: 'server' }),
    currentType: 'black',
    newScope: 'server',
  });

  assert.equal(noOptions.hasRequestedChanges, false);
  assert.equal(sameScope.hasRequestedChanges, true);
  assert.equal(sameScope.isScopeChange, false);
  assert.deepEqual(sameScope.changes, []);
});

test('list edit plan keeps manual-alt duplicate reporting and raid validation', () => {
  const plan = buildListEditPlan({
    existing: makeEntry(),
    currentType: 'black',
    newRaidInput: 'Definitely not a raid',
    additionalNamesRaw: 'Existingalt, Newalt, Mainchar',
  });

  assert.equal(plan.invalidRaid, true);
  assert.deepEqual(plan.additionalNamesParsed.added, ['Newalt']);
  assert.deepEqual(plan.additionalNamesParsed.duplicates, ['Existingalt', 'Mainchar']);
  assert.equal(plan.changes.length, 1);
});

test('scope-conflict query preserves the global and server uniqueness boundaries', () => {
  const existing = makeEntry();
  assert.deepEqual(buildScopeConflictQuery({
    existing,
    targetScope: 'global',
    guildId: 'guild-1',
  }), {
    name: 'Mainchar',
    scope: 'global',
    _id: { $ne: existing._id },
  });
  assert.deepEqual(buildScopeConflictQuery({
    existing,
    targetScope: 'server',
    guildId: 'guild-1',
  }), {
    name: 'Mainchar',
    scope: 'server',
    guildId: 'guild-1',
    _id: { $ne: existing._id },
  });
});
