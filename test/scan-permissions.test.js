import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OFFICER_APPROVER_IDS = 'officer-1';
process.env.SENIOR_APPROVER_IDS = 'senior-1';
process.env.MEMBER_APPROVER_IDS = 'member-1';

const { isPrivilegedStrongholdScanUser } = await import('../bot/utils/scanPermissions.js');
const { reserveUserScan } = await import('../bot/utils/scanSession.js');

test('Stronghold scan privileged users are officers and seniors only', () => {
  assert.equal(isPrivilegedStrongholdScanUser('officer-1'), true);
  assert.equal(isPrivilegedStrongholdScanUser('senior-1'), true);
  assert.equal(isPrivilegedStrongholdScanUser('member-1'), false);
  assert.equal(isPrivilegedStrongholdScanUser('regular-1'), false);
});

test('regular users can reserve only one active Stronghold scan', () => {
  const first = reserveUserScan('regular-1', { label: 'first scan' });
  assert.equal(first.ok, true);

  const second = reserveUserScan('regular-1', { label: 'second scan' });
  assert.equal(second.ok, false);
  assert.equal(second.active.label, 'first scan');

  first.release();

  const third = reserveUserScan('regular-1', { label: 'third scan' });
  assert.equal(third.ok, true);
  third.release();
});

test('privileged users can bypass the one-active-scan reservation', () => {
  const first = reserveUserScan('officer-1', { label: 'first scan' }, {
    allowMultiple: isPrivilegedStrongholdScanUser('officer-1'),
  });
  const second = reserveUserScan('officer-1', { label: 'second scan' }, {
    allowMultiple: isPrivilegedStrongholdScanUser('officer-1'),
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});
