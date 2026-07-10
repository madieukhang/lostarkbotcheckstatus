import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildListEvidenceNameQuery } = await import('../bot/handlers/list/evidence/command.js');

test('/la-evidence free-typed lookup checks primary name and tracked alts', () => {
  assert.deepEqual(
    buildListEvidenceNameQuery('Altname'),
    {
      $or: [
        { name: { $in: ['Altname'] } },
        { allCharacters: { $in: ['Altname'] } },
      ],
    }
  );
});
