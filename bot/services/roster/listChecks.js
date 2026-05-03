import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import { buildBlacklistQuery } from '../../utils/scope.js';

export async function handleRosterBlackListCheck(names, options = {}) {
  try {
    await connectDB();

    const { guildId } = options;
    const nameQuery = { $or: [{ name: { $in: names } }, { allCharacters: { $in: names } }] };

    const entry = await Blacklist.findOne(buildBlacklistQuery(nameQuery, guildId))
      .sort({ scope: -1 })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (entry) {
      console.log(`[blacklist] "${entry.name}" is BLACKLISTED - reason: ${entry.reason || '(none)'}`);
      return {
        name: entry.name,
        reason: entry.reason ?? '',
        raid: entry.raid ?? '',
        imageUrl: entry.imageUrl ?? '',
        imageMessageId: entry.imageMessageId ?? '',
        imageChannelId: entry.imageChannelId ?? '',
        addedByDisplayName: entry.addedByDisplayName ?? '',
        addedByName: entry.addedByName ?? '',
        addedByTag: entry.addedByTag ?? '',
        addedByUserId: entry.addedByUserId ?? '',
      };
    }

    console.log('[blacklist] No blacklisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[blacklist] Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    return null;
  }
}

export async function handleRosterWhiteListCheck(names) {
  try {
    console.log(`[whitelist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDB();

    const entry = await Whitelist.findOne({
      $or: [
        { name: { $in: names } },
        { allCharacters: { $in: names } },
      ],
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (entry) {
      console.log(`[whitelist] "${entry.name}" is WHITELISTED - reason: ${entry.reason || '(none)'}`);
      return {
        name: entry.name,
        reason: entry.reason ?? '',
        raid: entry.raid ?? '',
        imageUrl: entry.imageUrl ?? '',
        imageMessageId: entry.imageMessageId ?? '',
        imageChannelId: entry.imageChannelId ?? '',
        addedByDisplayName: entry.addedByDisplayName ?? '',
        addedByName: entry.addedByName ?? '',
        addedByTag: entry.addedByTag ?? '',
        addedByUserId: entry.addedByUserId ?? '',
      };
    }

    console.log('[whitelist] No whitelisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[whitelist] Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    return null;
  }
}

export function buildRosterStatusContent(name, result, label) {
  const reason = result.reason ? ` - *${result.reason}*` : '';
  const raid = result.raid ? ` [${result.raid}]` : '';
  return `${label} **${name}**${label === '⛔' ? ' is on the blacklist.' : ' is on the whitelist.'}${raid}${reason}`;
}
