import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = 'senior-b,senior-a,senior-b';
process.env.OFFICER_APPROVER_IDS = 'senior-a,officer-c';
process.env.MEMBER_APPROVER_IDS = 'member-d';

const { getApproverRecipientIds, getSeniorApproverIds } = await import('../bot/handlers/list/helpers.js');

test('approval recipients preserve senior order and avoid duplicate officer DMs', (context) => {
  assert.deepEqual(getSeniorApproverIds(), ['senior-b', 'senior-a']);
  context.mock.method(Math, 'random', () => 0);
  assert.deepEqual(getApproverRecipientIds(), ['senior-b', 'senior-a']);
  Math.random.mock.mockImplementation(() => 0.99);
  assert.deepEqual(getApproverRecipientIds(), ['senior-b', 'senior-a', 'officer-c']);
  const seniors = getSeniorApproverIds();
  seniors.push('mutated');
  assert.deepEqual(getSeniorApproverIds(), ['senior-b', 'senior-a']);
});
