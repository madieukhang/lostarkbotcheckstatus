/**
 * bot.js
 * Entry point for the Lost Ark server-status Discord bot.
 *
 * Responsibilities:
 *  - Create and log in the Discord client
 *  - Register application (slash) commands on startup
 *  - Handle slash command interactions
 *  - Start the background monitoring loop
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionType,
} from 'discord.js';
import { JSDOM } from 'jsdom';

import config from './config.js';
import { startMonitor, checkStatus, getState, resetState } from './monitor.js';
import { STATUS } from './serverStatus.js';
import { connectDB } from './db.js';
import Blacklist from './models/Blacklist.js';

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    // Guild intents are required even for a slash-command-only bot
    GatewayIntentBits.Guilds,
  ],
});

// ─── Slash command definitions ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the current cached Brelshaza server status'),

  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Force an immediate server status check right now'),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset the stored status state back to default'),

  new SlashCommandBuilder()
    .setName('roster')
    .setDescription('List the roster for a Lost Ark character')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Character name to look up (e.g. Lazy)')
        .setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

// ─── Register commands with Discord ──────────────────────────────────────────

/**
 * Register slash commands globally (available in all guilds the bot is in).
 * Global commands can take up to 1 hour to propagate; for development
 * you can register them per-guild for instant updates by passing a guildId.
 */
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('[bot] Registering slash commands…');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[bot] Slash commands registered successfully.');
  } catch (err) {
    console.error('[bot] Failed to register slash commands:', err.message);
  }
}

// ─── Helper: status label with emoji ─────────────────────────────────────────

/**
 * Return a human-readable, emoji-decorated status string.
 * @param {string|null} status
 * @returns {string}
 */
function formatStatus(status) {
  switch (status) {
    case STATUS.ONLINE:       return '🟢 Online';
    case STATUS.OFFLINE:      return '🔴 Offline';
    case STATUS.MAINTENANCE:  return '🟡 Maintenance';
    default:                  return '❓ Unknown';
  }
}

// ─── Interaction handlers ─────────────────────────────────────────────────────

/**
 * /status – return the last cached status without hitting the website.
 */
async function handleStatusCommand(interaction) {
  await interaction.deferReply(); // Might take a moment to read the file

  const state = await getState();

  const embed = new EmbedBuilder()
    .setTitle('Server status – Server Status')
    .addFields(
      {
        name: 'Current Status',
        value: formatStatus(state.lastStatus),
        inline: true,
      },
      {
        name: 'Last Checked',
        value: state.lastCheckTime
          ? `<t:${Math.floor(new Date(state.lastCheckTime).getTime() / 1000)}:R>`
          : 'Never',
        inline: true,
      },
      {
        name: 'Last Alert Sent',
        value: state.lastAlertTime
          ? `<t:${Math.floor(new Date(state.lastAlertTime).getTime() / 1000)}:R>`
          : 'Never',
        inline: true,
      }
    )
    .setColor(
      state.lastStatus === STATUS.ONLINE
        ? 0x57f287 // Green
        : state.lastStatus === STATUS.MAINTENANCE
        ? 0xfee75c // Yellow
        : 0xed4245 // Red / unknown
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /check – force an immediate live status check and report the result.
 */
async function handleCheckCommand(interaction) {
  await interaction.deferReply();

  try {
    const current = await checkStatus(client, { force: true });
    const embed = new EmbedBuilder()
      .setTitle('Server status – Live Check')
      .setDescription(`Status right now: **${formatStatus(current)}**`)
      .setColor(
        current === STATUS.ONLINE
          ? 0x57f287
          : current === STATUS.MAINTENANCE
          ? 0xfee75c
          : 0xed4245
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({
      content: `⚠️ Failed to fetch server status: \`${err.message}\``,
    });
  }
}

/**
 * /roster – scrape lostark.bible via ScraperAPI proxy to bypass Cloudflare.
 */
async function handleRosterCommand(interaction) {
  const raw = interaction.options.getString('name');
  const name = raw.trim().charAt(0).toUpperCase() + raw.trim().slice(1).toLowerCase();
  await interaction.deferReply();

  try {
    const targetUrl = `https://lostark.bible/character/NA/${name}/roster`;
    const proxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const { document } = new JSDOM(html).window;

    const characters = [];
    const links = document.querySelectorAll('a[href^="/character/NA/"]');

    for (const link of links) {
      const headerDiv = link.querySelector('.text-lg.font-semibold');
      if (!headerDiv) continue;

      // First bare text node = character name
      const charName = [...headerDiv.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .find((t) => t.length > 0);

      const spans = headerDiv.querySelectorAll('span');
      const itemLevel = spans[0]?.textContent.trim() ?? '?';
      const combatScore = spans[1]?.textContent.trim() ?? '?';

      if (charName) characters.push({ name: charName, itemLevel, combatScore });
    }

    if (characters.length === 0) {
      const suggestions = await fetchNameSuggestions(name);
      const filtered = suggestions.filter((s) => s.itemLevel > 1680);
      if (filtered.length > 0) {
        const suggLines = filtered
          .map((s) => `[${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) · \`${s.itemLevel}\` · ${s.cls}`)
          .join('\n');
        const embed = new EmbedBuilder()
          .setDescription(suggLines)
          .setColor(0xed4245)
          .setTimestamp();
        await interaction.editReply({
          content: `❌ No roster found for **${name}**. Names similar to **${name}**:`,
          embeds: [embed],
        });
      } else {
        await interaction.editReply({
          content: `❌ No roster found for **${name}**. Check the name and try again.`,
        });
      }
      return;
    }

    // Fetch titles in parallel for the first 10 characters only
    await Promise.all(
      characters.slice(0, 10).map(async (c) => {
        try {
          const charProxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(`https://lostark.bible/character/NA/${c.name}`)}`;
          const res = await fetch(charProxyUrl);
          if (!res.ok) return;
          const charHtml = await res.text();
          const { document: charDoc } = new JSDOM(charHtml).window;
          const h2 = charDoc.querySelector('h2.flex.items-center');
          const titleSpan = h2?.querySelector('span[style*="color"]');
          c.title = titleSpan?.textContent.trim() ?? null;
        } catch {
          c.title = null;
        }
      })
    );

    const lines = characters.map(
      (c, i) =>
        `**${i + 1}.** ${c.name} · \`${c.itemLevel}\`${c.title ? ` — *${c.title}*` : ''} · ${c.combatScore}`
    );

    // Discord embed description cap is 4096 chars; trim if needed
    let description = lines.join('\n');
    if (description.length > 4000) {
      description = description.slice(0, 4000) + '\n…';
    }

    // ── Blacklist check ────────────────────────────────────────────────────
    // Check characters with item level 1640+
    const charNames = characters
      .filter((c) => parseFloat((c.itemLevel ?? '0').replace(/,/g, '')) >= 1640)
      .map((c) => c.name);
    const blacklistResult = await handleRosterBlackListCheck(charNames);

    const embed = new EmbedBuilder()
      .setTitle(`Roster – ${name}`)
      .setURL(targetUrl)
      .setDescription(description)
      .setColor(blacklistResult ? 0xed4245 : 0x5865f2)
      .setFooter({ text: `${characters.length} character(s) · lostark.bible` })
      .setTimestamp();

    let content = undefined;
    if (blacklistResult) {
      const reason = blacklistResult.reason ? ` — *${blacklistResult.reason}*` : '';
      content = `⛔ **${name}** is on the blacklist.${reason}`;
    }

    await interaction.editReply({ content, embeds: [embed] });
  } catch (err) {
    await interaction.editReply({
      content: `⚠️ Failed to fetch roster: \`${err.message}\``,
    });
  }
}

/**
 * Suggest similar NA character names using lostark.bible's internal search API.
 * Payload format: Base64(JSON([[1,2], name, "NA"]))
 * Result is a compact flat array where data[0] holds pointers to each character group.
 * Each group is [nameIdx, classIdx, itemLevelIdx] referencing positions in the flat array.
 * @param {string} name  Title-cased character name
 * @returns {Promise<Array<{name: string, itemLevel: number, cls: string}>>}
 */
async function fetchNameSuggestions(name) {
  try {
    const payload = Buffer.from(JSON.stringify([[1, 2], name, 'NA'])).toString('base64');
    const targetUrl = `https://lostark.bible/_app/remote/ngsbie/search?payload=${encodeURIComponent(payload)}`;
    const proxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];

    const json = await res.json();
    if (json.type !== 'result' || !json.result) return [];

    const data = JSON.parse(json.result);
    if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length === 0) return [];

    // data[0] = array of pointers; each pointer p → data[p] = [nameIdx, classIdx, ilvlIdx]
    return data[0]
      .map((p) => {
        const group = data[p];
        if (!Array.isArray(group) || group.length < 3) return null;
        const [nameIdx, classIdx, ilvlIdx] = group;
        const charName = data[nameIdx];
        if (!charName || typeof charName !== 'string') return null;
        return {
          name: charName,
          cls: data[classIdx] ?? '',
          itemLevel: data[ilvlIdx] ?? 0,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Loop name checks against the blacklist collection in Blacklist DB.
 * @param {string[]} names  List of character names to check against the blacklist.
 * @returns {Promise<{ name: string, reason: string } | null>}
 */
async function handleRosterBlackListCheck(names) {
  try {
    console.log(`[blacklist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDB();

    const allDocs = await Blacklist.find({}).lean();
    console.log(`[blacklist] Total docs in DB: ${allDocs.length}`);
    allDocs.forEach((doc) => {
      console.log(`[blacklist] DB entry — name: "${doc.name}" (length: ${doc.name.length}, charCodes: ${[...doc.name].map(c => c.charCodeAt(0)).join(',')})`);
    });

    for (const charName of names) {
      const entry = await Blacklist.findOne({ name: charName })
        .collation({ locale: 'en', strength: 2 })
        .lean();
      if (entry) {
        console.log(`[blacklist] ⛔ "${charName}" is BLACKLISTED — reason: ${entry.reason || '(none)'}`);
        return { name: entry.name, reason: entry.reason ?? '' };
      }
    }

    console.log('[blacklist] ✅ No blacklisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[blacklist] ❌ Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    return null;
  }
}

/**
 * /reset – wipe the stored state JSON back to defaults.
 */
async function handleResetCommand(interaction) {
  await interaction.deferReply();
  await resetState();
  await interaction.editReply({
    content: '✅ State has been reset. The bot will start tracking from the next check.',
  });
}

// ─── Event: client ready ──────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);

  // Register slash commands now that we have the client ID
  await registerCommands();

  // Start the background polling monitor
  startMonitor(client);
});

// ─── Event: interaction created ──────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  // Only handle slash (chat input) commands
  if (interaction.type !== InteractionType.ApplicationCommand) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'status') {
      await handleStatusCommand(interaction);
    } else if (commandName === 'check') {
      await handleCheckCommand(interaction);
    } else if (commandName === 'reset') {
      await handleResetCommand(interaction);
    } else if (commandName === 'roster') {
      await handleRosterCommand(interaction);
    }
  } catch (err) {
    console.error(`[bot] Unhandled error in /${commandName}:`, err);

    // Reply with an error if we haven't already responded
    const reply = { content: '❌ An unexpected error occurred.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// ─── Event: unhandled errors ──────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err);
  // Allow the process to exit so Docker/process managers can restart it
  process.exit(1);
});

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(config.token);
