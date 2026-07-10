import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

let createButtonRoutes;
let createCommandRoutes;
let createSelectRoutes;
let dispatchCommandRoute;
let findCustomIdRoute;

test.before(async () => {
  ({
    createButtonRoutes,
    createCommandRoutes,
    createSelectRoutes,
    dispatchCommandRoute,
    findCustomIdRoute,
  } = await import('../bot/app/interaction-router.js'));
});

test('interaction router button table dispatches list-enrich actions by customId prefix', async () => {
  const calls = [];
  const routes = createButtonRoutes({
    handleListEnrichConfirmButton: async () => calls.push('confirm'),
    handleListEnrichContinueButton: async () => calls.push('continue'),
    handleListEnrichCancelButton: async () => calls.push('cancel'),
  });

  for (const [customId, expected] of [
    ['list-enrich:confirm:123', 'confirm'],
    ['list-enrich:continue:123', 'continue'],
    ['list-enrich:cancel:123', 'cancel'],
  ]) {
    const route = findCustomIdRoute(routes, customId);
    assert.ok(route);
    await route.handle({ customId });
    assert.equal(calls.at(-1), expected);
  }
});

test('interaction router dispatches compact broadcast evidence buttons', async () => {
  let received = null;
  const routes = createButtonRoutes({
    handleBroadcastEvidenceButton: async (interaction) => { received = interaction.customId; },
  });

  const customId = 'listbroadcast_evidence:123456789:987654321';
  const route = findCustomIdRoute(routes, customId);
  assert.ok(route);
  await route.handle({ customId });
  assert.equal(received, customId);
});

test('interaction router select table supports exact and prefixed customIds', async () => {
  let quickAddCalls = 0;
  const routes = createSelectRoutes({
    handleQuickAddSelect: async () => { quickAddCalls += 1; },
  });

  const exactRoute = findCustomIdRoute(routes, 'quickadd_select');
  assert.ok(exactRoute);
  await exactRoute.handle({});
  assert.equal(quickAddCalls, 1);

  const helpRoute = findCustomIdRoute(routes, 'la-help:select:vi');
  assert.ok(helpRoute);
  assert.equal(helpRoute.label, '[la-help] Select error:');
});

test('interaction router command table dispatches top-level and la-list subcommands', async () => {
  const calls = [];
  const commandRoutes = createCommandRoutes({
    systemHandlers: {
      handleStatusCommand: async () => calls.push('status'),
      handleResetCommand: async () => calls.push('reset'),
    },
    listHandlers: {
      handleListTrustCommand: async () => calls.push('trust'),
      handleListCheckCommand: async () => calls.push('check'),
    },
  });

  await dispatchCommandRoute(
    {
      commandName: 'la-list',
      options: { getSubcommand: () => 'trust' },
    },
    commandRoutes,
  );
  await dispatchCommandRoute({ commandName: 'la-check' }, commandRoutes);

  assert.deepEqual(calls, ['trust', 'check']);
});
