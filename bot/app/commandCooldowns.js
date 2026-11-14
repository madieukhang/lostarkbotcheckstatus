/**
 * app/commandCooldowns.js
 * Per-member cooldowns for the interactions that spend shared or paid work:
 * Gemini OCR, ScraperAPI and worker roster reads, and list writes that
 * archive evidence and post to the owner's channels. Officers and seniors
 * are never limited. Process-local.
 */

import UserPreference from '../models/UserPreference.js';
import { getUserLanguage, t } from '../services/i18n/index.js';
import { NoticeKind } from '../utils/alertEmbed.js';
import { isOfficerOrSenior } from '../utils/approverRoles.js';
import { createCooldownStore } from '../utils/cooldownStore.js';
import { replyAlert } from '../utils/interactionReplies.js';
import { LIST_FORM_IDS } from '../handlers/list/form/fields.js';

const BUCKET_MS = Object.freeze({
  check: 15_000,
  roster: 5_000,
  search: 5_000,
  listWrite: 10_000,
});

// Route key (command, "command subcommand", or modal id) to its bucket. A
// list add or edit shares one bucket whether it came from options or a form.
const ROUTE_BUCKETS = Object.freeze({
  'la-check': 'check',
  'la-roster': 'roster',
  'la-search': 'search',
  'la-list add': 'listWrite',
  'la-list edit': 'listWrite',
  [LIST_FORM_IDS.addModal]: 'listWrite',
  [LIST_FORM_IDS.quickAddModal]: 'listWrite',
  [LIST_FORM_IDS.editModal]: 'listWrite',
});

let stores = createStores();

function createStores(options) {
  return Object.fromEntries(Object.entries(BUCKET_MS).map(([bucket, ms]) => [bucket, createCooldownStore(ms, options)]));
}

function routeKey(interaction) {
  if (interaction.isChatInputCommand?.()) {
    const subcommand = interaction.options.getSubcommand(false);
    return subcommand ? `${interaction.commandName} ${subcommand}` : interaction.commandName;
  }
  if (interaction.isModalSubmit?.()) return String(interaction.customId || '').split(':')[0];
  return '';
}

/**
 * Refuse an interaction its member sent again inside its cooldown, with a
 * private notice; otherwise start the cooldown.
 * @param {import('discord.js').Interaction} interaction
 * @param {{getLang?: (userId: string) => Promise<string>}} [options]
 * @returns {Promise<boolean>} true when the interaction was refused
 */
export async function refuseCoolingDown(interaction, {
  getLang = (userId) => getUserLanguage(userId, { UserPreferenceModel: UserPreference }),
} = {}) {
  const bucket = ROUTE_BUCKETS[routeKey(interaction)];
  const userId = interaction.user?.id;
  if (!bucket || !userId || isOfficerOrSenior(userId)) return false;
  const store = stores[bucket];
  const remainingMs = store.remainingMs(userId);
  if (remainingMs <= 0) {
    store.mark(userId);
    return false;
  }
  const lang = await getLang(userId);
  await replyAlert(interaction, {
    kind: NoticeKind.BUSY,
    ...t('dialogue.common.cooldown', lang, { seconds: Math.ceil(remainingMs / 1000) }),
  });
  return true;
}

/**
 * Start every cooldown afresh. Test seam.
 * @param {{now?: () => number}} [options] - clock for the new cooldowns
 * @returns {void}
 */
export function resetCommandCooldowns(options) {
  for (const store of Object.values(stores)) store.clear();
  stores = createStores(options);
}
