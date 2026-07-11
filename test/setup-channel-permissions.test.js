import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { checkBotPermissions } from '../bot/services/setup/channelPermissions.js';

function channelWithPermissions(allowed) {
  return {
    permissionsFor() {
      return {
        has(flag) {
          return allowed.has(flag);
        },
      };
    },
  };
}

const guild = { members: { me: { id: 'bot' } } };
const basePermissions = new Set([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.EmbedLinks,
]);

test('welcome setup requires Discord Pin Messages separately from Manage Messages', () => {
  const allowed = new Set([...basePermissions, PermissionFlagsBits.ManageMessages]);

  const result = checkBotPermissions(
    channelWithPermissions(allowed),
    guild,
    { welcomePin: true }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['Pin Messages']);
});

test('cleanup-enabled welcome setup passes only when cleanup and pin permissions are both present', () => {
  const allowed = new Set([
    ...basePermissions,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.PinMessages,
  ]);

  const result = checkBotPermissions(
    channelWithPermissions(allowed),
    guild,
    { cleanup: true, welcomePin: true }
  );

  assert.deepEqual(result, { ok: true, missing: [] });
});

test('server-local welcome pin does not require Manage Messages when cleanup is off', () => {
  const allowed = new Set([
    ...basePermissions,
    PermissionFlagsBits.PinMessages,
  ]);

  const result = checkBotPermissions(
    channelWithPermissions(allowed),
    guild,
    { welcomePin: true }
  );

  assert.deepEqual(result, { ok: true, missing: [] });
});

test('daily cleanup permission check identifies revoked Manage Messages', () => {
  const result = checkBotPermissions(
    channelWithPermissions(basePermissions),
    guild,
    { cleanup: true }
  );

  assert.deepEqual(result.missing, ['Manage Messages']);
});
