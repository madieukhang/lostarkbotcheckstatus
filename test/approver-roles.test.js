import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OFFICER_APPROVER_IDS = 'officer-1';
process.env.SENIOR_APPROVER_IDS = 'senior-1';
process.env.MEMBER_APPROVER_IDS = 'member-1';

const { isOfficerOrSenior, isSeniorApprover } = await import('../bot/utils/approverRoles.js');
const helpers = await import('../bot/handlers/list/helpers.js');

test('isOfficerOrSenior accepts seniors and officers only', () => {
  assert.equal(isOfficerOrSenior('senior-1'), true);
  assert.equal(isOfficerOrSenior('officer-1'), true);
  assert.equal(isOfficerOrSenior('member-1'), false);
  assert.equal(isOfficerOrSenior('regular-1'), false);
});

test('isOfficerOrSenior and isSeniorApprover reject a missing id', () => {
  for (const missing of [undefined, null, '']) {
    assert.equal(isOfficerOrSenior(missing), false);
    assert.equal(isSeniorApprover(missing), false);
  }
});

test('isSeniorApprover accepts seniors only', () => {
  assert.equal(isSeniorApprover('senior-1'), true);
  assert.equal(isSeniorApprover('officer-1'), false);
  assert.equal(isSeniorApprover('member-1'), false);
  assert.equal(isSeniorApprover('regular-1'), false);
});

test('the list helpers hand out the same officer or senior check', () => {
  assert.equal(helpers.isOfficerOrSenior, isOfficerOrSenior);
});
