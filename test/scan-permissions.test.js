import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OFFICER_APPROVER_IDS = 'officer-1';
process.env.SENIOR_APPROVER_IDS = 'senior-1';
process.env.MEMBER_APPROVER_IDS = 'member-1';

const { isPrivilegedStrongholdScanUser } = await import('../bot/utils/scanPermissions.js');
const { reserveUserScan } = await import('../bot/utils/scanSession.js');
const { reserveStrongholdScanForInteraction } = await import('../bot/utils/strongholdScanGate.js');

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

test('the Stronghold scan gate lets only privileged users run scans in parallel', () => {
  const asUser = (id) => ({ user: { id } });

  const officerFirst = reserveStrongholdScanForInteraction(asUser('officer-1'), 'first scan');
  const officerSecond = reserveStrongholdScanForInteraction(asUser('officer-1'), 'second scan');
  const memberFirst = reserveStrongholdScanForInteraction(asUser('member-1'), 'first scan');
  const memberSecond = reserveStrongholdScanForInteraction(asUser('member-1'), 'second scan');

  assert.equal(officerFirst.ok, true);
  assert.equal(officerSecond.ok, true);
  assert.equal(memberFirst.ok, true);
  assert.equal(memberSecond.ok, false);

  officerFirst.release();
  officerSecond.release();
  memberFirst.release();
});
