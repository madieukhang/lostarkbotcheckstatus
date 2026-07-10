import { PermissionFlagsBits } from 'discord.js';

const BASE_CHANNEL_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
  { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
  { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
  { flag: PermissionFlagsBits.EmbedLinks, name: 'Embed Links' },
];

const CLEANUP_PERMISSION = {
  flag: PermissionFlagsBits.ManageMessages,
  name: 'Manage Messages',
};

const PIN_PERMISSION = {
  flag: PermissionFlagsBits.PinMessages,
  name: 'Pin Messages',
};

export function checkBotPermissions(
  channel,
  guild,
  { cleanup = false, welcomePin = false } = {}
) {
  const required = [...BASE_CHANNEL_PERMISSIONS];
  if (cleanup || welcomePin) required.push(CLEANUP_PERMISSION);
  if (welcomePin) required.push(PIN_PERMISSION);

  const botMember = guild?.members?.me;
  if (!botMember) return { ok: false, missing: ['Cannot resolve bot member'] };

  let perms;
  try {
    perms = channel?.permissionsFor?.(botMember);
  } catch {
    perms = null;
  }
  const missing = !perms
    ? required.map((entry) => entry.name)
    : required.filter((entry) => !perms.has(entry.flag)).map((entry) => entry.name);
  return { ok: missing.length === 0, missing };
}
