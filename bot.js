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
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { JSDOM } from 'jsdom';

import config from './config.js';
import { startMonitor, checkStatus, getState, resetState } from './monitor.js';
import { STATUS } from './serverStatus.js';
import { connectDB } from './db.js';
import Blacklist from './models/Blacklist.js';
import Whitelist from './models/Whitelist.js';
import { getClassName } from './models/Class.js';
import { getRaidChoices } from './models/Raid.js';

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

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('Manage black/white list entries')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a character (will include in roster checks) to black/white list')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Which list to update')
            .setRequired(true)
            .addChoices(
              { name: 'black', value: 'black' },
              { name: 'white', value: 'white' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Character name to add')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('reason')
            .setDescription('Reason for this entry')
            .setRequired(true)
        )
        .addStringOption((opt) => {
          opt
            .setName('raid')
            .setDescription('Optional raid tag for this entry')
            .setRequired(false);

          for (const choice of getRaidChoices()) {
            opt.addChoices(choice);
          }

          return opt;
        })
        .addAttachmentOption((opt) =>
          opt
            .setName('image')
            .setDescription('Optional screenshot image')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a character from black/white list')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Character name to remove')
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('listcheck')
    .setDescription('Check multiple names against blacklist/whitelist')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption((opt) =>
      opt
        .setName('image')
        .setDescription('Team screenshot for Gemini to extract up to 8 names')
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('show_reason')
        .setDescription('Show blacklist/whitelist reason in result (default: not shown)')
        .setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

// ─── Register commands with Discord ──────────────────────────────────────────

/**
 * Register slash commands globally (available in all guilds the bot is in).
 * Global commands can take up to 1 hour to propagate.
 */
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('[bot] Registering global slash commands…');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[bot] Global slash commands registered successfully.');
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
          .map((s) => `[${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) — \`${Number(s.itemLevel).toFixed(2)}\` — ${getClassName(s.cls)}`)
          .join('\n');
        const embed = new EmbedBuilder()
          .setDescription(suggLines)
          .setColor(0xed4245)
          .setTimestamp();
        await interaction.editReply({
          content: `❌ No roster found for **${name}**. Rosters similar to **${name}**:`,
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

    // ── Blacklist/Whitelist checks ─────────────────────────────────────────
    // Check characters with item level 1680+
    const charNames = characters
      .filter((c) => parseFloat((c.itemLevel ?? '0').replace(/,/g, '')) >= 1680)
      .map((c) => c.name);

    const [blacklistResult, whitelistResult] = await Promise.all([
      handleRosterBlackListCheck(charNames),
      handleRosterWhiteListCheck(charNames),
    ]);

    const embed = new EmbedBuilder()
      .setTitle(`Roster – ${name}`)
      .setURL(targetUrl)
      .setDescription(description)
      .setColor(blacklistResult ? 0xed4245 : whitelistResult ? 0x57f287 : 0x5865f2)
      .setFooter({ text: `${characters.length} character(s) · lostark.bible` })
      .setTimestamp();

    const embeds = [embed];

    const contentLines = [];
    if (blacklistResult) {
      const reason = blacklistResult.reason ? ` — *${blacklistResult.reason}*` : '';
      const raid = blacklistResult.raid ? ` [${blacklistResult.raid}]` : '';
      contentLines.push(`⛔ **${name}** is on the blacklist.${raid}${reason}`);

      if (blacklistResult.imageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Blacklist evidence')
          .setImage(blacklistResult.imageUrl)
          .setColor(0xed4245);
        embeds.unshift(evidenceEmbed);
      }
    }

    if (whitelistResult) {
      const reason = whitelistResult.reason ? ` — *${whitelistResult.reason}*` : '';
      const raid = whitelistResult.raid ? ` [${whitelistResult.raid}]` : '';
      contentLines.push(`✅ **${name}** is on the whitelist.${raid}${reason}`);

      if (whitelistResult.imageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Whitelist evidence')
          .setImage(whitelistResult.imageUrl)
          .setColor(0x57f287);
        embeds.unshift(evidenceEmbed);
      }
    }

    const content = contentLines.length > 0 ? contentLines.join('\n') : undefined;

    await interaction.editReply({ content, embeds });
  } catch (err) {
    await interaction.editReply({
      content: `⚠️ Failed to fetch roster: \`${err.message}\``,
    });
  }
}

function getListContext(type) {
  if (type === 'black') {
    return {
      model: Blacklist,
      label: 'blacklist',
      color: 0xed4245,
      icon: '⛔',
    };
  }

  return {
    model: Whitelist,
    label: 'whitelist',
    color: 0x57f287,
    icon: '✅',
  };
}

function normalizeCharacterName(raw) {
  const value = raw.trim();
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function extractJsonArrayFromText(raw) {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  const match = trimmed.match(/\[[\s\S]*\]/);
  return match ? match[0] : null;
}

function shouldFailoverGeminiModel(status, bodyText) {
  const text = (bodyText || '').toLowerCase();
  if (status === 429 || status === 503) return true;
  return (
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('too many requests')
  );
}

function buildGeminiRequestBody(mimeType, imageBase64) {
  const prompt = [
    'Read this image and extract only Lost Ark character names that are clearly visible.',
    'Return JSON array only, no markdown, no explanation.',
    'Example output: ["name1","name2"].',
    'If no valid names are found, return [].',
  ].join(' ');

  return {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      maxOutputTokens: 512,
    },
  };
}

function parseGeminiNamesFromPayload(payload) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? '')
    .join('')
    .trim();

  if (!text) return [];

  const jsonArrayText = extractJsonArrayFromText(text);
  if (!jsonArrayText) {
    throw new Error('Gemini did not return a JSON array.');
  }

  const parsed = JSON.parse(jsonArrayText);
  if (!Array.isArray(parsed)) {
    throw new Error('Gemini output is not an array.');
  }

  const names = parsed
    .map((item) => (typeof item === 'string' ? normalizeCharacterName(item) : ''))
    .filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }

  return unique;
}

async function extractNamesFromImageWithGemini(image) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  if (image.contentType && !image.contentType.startsWith('image/')) {
    throw new Error('Attachment must be an image file.');
  }

  const imageRes = await fetch(image.url, { signal: AbortSignal.timeout(15000) });
  if (!imageRes.ok) {
    throw new Error(`Failed to download attachment (HTTP ${imageRes.status})`);
  }

  const mimeType = image.contentType || imageRes.headers.get('content-type') || 'image/png';
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const imageBase64 = imageBuffer.toString('base64');

  const models = config.geminiModels.length > 0 ? config.geminiModels : ['gemini-2.5-flash', 'gemini-3.1-flash-lite-2'];
  const requestBody = buildGeminiRequestBody(mimeType, imageBase64);
  const failures = [];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    const aiRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      failures.push(`${model}: HTTP ${aiRes.status}`);

      const canFallback = i < models.length - 1;
      if (canFallback && shouldFailoverGeminiModel(aiRes.status, errBody)) {
        console.warn(`[listcheck] Gemini quota/rate hit on ${model}, trying fallback model.`);
        continue;
      }

      throw new Error(`Gemini request failed on ${model} (HTTP ${aiRes.status}) ${errBody}`.trim());
    }

    const payload = await aiRes.json();
    return parseGeminiNamesFromPayload(payload);
  }

  throw new Error(`All Gemini models failed: ${failures.join(' | ')}`);
}

/**
 * /listcheck – check multiple names across blacklist and whitelist.
 */
async function handleListCheckCommand(interaction) {
  const image = interaction.options.getAttachment('image', true);
  const showReason = interaction.options.getBoolean('show_reason') ?? false;
  let names = [];

  await interaction.deferReply();

  try {
    names = await extractNamesFromImageWithGemini(image);
  } catch (err) {
    await interaction.editReply({
      content: `⚠️ Failed to extract names from image: \`${err.message}\``,
    });
    return;
  }

  if (names.length === 0) {
    await interaction.editReply({
      content: '⚠️ No valid names found in the uploaded image. Please use a clearer screenshot.',
    });
    return;
  }

  // Limit to 8 names per command.
  const limitedNames = names.slice(0, 8);

  try {
    await connectDB();

    const results = await Promise.all(
      limitedNames.map(async (name) => {
        const [blackEntry, whiteEntry] = await Promise.all([
          Blacklist.findOne({ $or: [{ name }, { allCharacters: name }] })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
          Whitelist.findOne({ $or: [{ name }, { allCharacters: name }] })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
        ]);

        let hasRoster = false;
        if (!blackEntry && !whiteEntry) {
          const rosterResult = await buildRosterCharacters(name);
          hasRoster = rosterResult.hasValidRoster;
        }

        return { name, blackEntry, whiteEntry, hasRoster };
      })
    );

    const lines = results.map((item, idx) => {
      const isBlack = Boolean(item.blackEntry);
      const isWhite = Boolean(item.whiteEntry);
      const blackReason = item.blackEntry?.reason?.trim();
      const whiteReason = item.whiteEntry?.reason?.trim();

      const reasonParts = [];
      if (showReason && isBlack && blackReason) {
        reasonParts.push(`black: ${blackReason}`);
      }
      if (showReason && isWhite && whiteReason) {
        reasonParts.push(`white: ${whiteReason}`);
      }

      const reasonSuffix = reasonParts.length > 0 ? ` — ${reasonParts.join(' | ')}` : '';

      let icon = '';
      if (isBlack && isWhite) {
        icon = '⛔✅ ';
      } else if (isBlack) {
        icon = '⛔ ';
      } else if (isWhite) {
        icon = '✅ ';
      } else if (item.hasRoster) {
        icon ='❓ ';
      } else {
        return `${idx + 1}. No roster found: **${item.name}**`;
      }

      return `${idx + 1}. ${icon}**${item.name}**${reasonSuffix}`;
    });

    const sections = [
      `Checked: **${limitedNames.length}** name(s)`,
      'Source: **Gemini OCR from image**',
      limitedNames.length < names.length ? `Ignored: **${names.length - limitedNames.length}** extra name(s) (limit: 8)` : null,
      '',
      ...lines,
    ].filter((line) => line !== null);

    await interaction.editReply({
      content: sections.join('\n'),
    });
  } catch (err) {
    console.error('[listcheck] ❌ Check failed:', err.message);
    await interaction.editReply({
      content: `⚠️ Failed to run list check: \`${err.message}\``,
    });
  }
}

async function buildRosterCharacters(name) {
  let allCharacters = [name];
  let hasValidRoster = false;

  try {
    const targetUrl = `https://lostark.bible/character/NA/${name}/roster`;
    const proxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
    if (response.ok) {
      const html = await response.text();
      const { document } = new JSDOM(html).window;
      const links = document.querySelectorAll('a[href^="/character/NA/"]');
      const rosterChars = [];

      for (const link of links) {
        const headerDiv = link.querySelector('.text-lg.font-semibold');
        if (!headerDiv) continue;

        const charName = [...headerDiv.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .find((t) => t.length > 0);

        if (charName) rosterChars.push(charName);
      }

      if (rosterChars.length > 0) {
        hasValidRoster = true;
        allCharacters = [...new Set(rosterChars)];
      }
    }
  } catch (err) {
    console.warn('[list] Failed to fetch roster characters:', err.message);
  }

  return { hasValidRoster, allCharacters };
}

/**
 * /list add – add a character to blacklist/whitelist with reason + optional image.
 */
async function handleListAddCommand(interaction) {
  const type = interaction.options.getString('type', true);
  const rawName = interaction.options.getString('name', true).trim();
  const reason = interaction.options.getString('reason', true).trim();
  const raid = interaction.options.getString('raid') ?? '';
  const image = interaction.options.getAttachment('image');
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
  const { model, label, color, icon } = getListContext(type);

  await interaction.deferReply();

  if (image?.contentType && !image.contentType.startsWith('image/')) {
    await interaction.editReply({
      content: '❌ Attachment must be an image file.',
    });
    return;
  }

  try {
    const { hasValidRoster, allCharacters } = await buildRosterCharacters(name);

    if (!hasValidRoster) {
      const suggestions = await fetchNameSuggestions(name);
      if (suggestions.length > 0) {
        const suggestionLines = suggestions
          .slice(0, 10)
          .map(
            (s, idx) =>
              `**${idx + 1}.** [${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) — \`${Number(s.itemLevel || 0).toFixed(2)}\` — ${getClassName(s.cls)}`
          )
          .join('\n');

        const suggEmbed = new EmbedBuilder()
          .setTitle('No roster found')
          .setDescription(suggestionLines)
          .setColor(0xfee75c)
          .setTimestamp();

        await interaction.editReply({
          content: `❌ No roster found for **${name}**. Re-run **/list add type:${type}** with one of the suggested names.`,
          embeds: [suggEmbed],
        });
      } else {
        await interaction.editReply({
          content: `❌ No roster found for **${name}**, and no similar name suggestions were found.`,
        });
      }
      return;
    }

    await connectDB();

    const existed = await model.findOne({
      $or: [{ name }, { allCharacters: name }],
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (existed) {
      await interaction.editReply({
        content: `⚠️ **${name}** already exists in ${label}.`,
      });
      return;
    }

    const entry = await model.create({
      name,
      reason,
      raid,
      imageUrl: image?.url ?? '',
      allCharacters,
      addedByUserId: interaction.user.id,
      addedByTag: interaction.user.tag,
    });

    const embed = new EmbedBuilder()
      .setTitle(`${label} entry added`)
      .addFields(
        { name: 'Name', value: entry.name, inline: true },
        { name: 'Reason', value: reason || 'N/A', inline: true },
        { name: 'Raid', value: raid || 'N/A', inline: true },
        { name: 'All Characters', value: String(allCharacters.length), inline: true }
      )
      .setColor(color)
      .setTimestamp(new Date());

    if (image?.url) {
      embed.setImage(image.url);
    }

    await interaction.editReply({
      content: `${icon} Added **${entry.name}** to ${label}.`,
      embeds: [embed],
    });
  } catch (err) {
    if (err?.code === 11000) {
      await interaction.editReply({
        content: `⚠️ **${name}** is already in ${label}.`,
      });
      return;
    }

    console.error(`[${label}] ❌ Add failed:`, err.message);
    await interaction.editReply({
      content: `⚠️ Failed to add ${label} entry: \`${err.message}\``,
    });
  }
}

/**
 * /list remove – remove an entry only if requester is the creator.
 */
async function handleListRemoveCommand(interaction) {
  const rawName = interaction.options.getString('name', true).trim();
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();

  await interaction.deferReply();

  try {
    await connectDB();

    const [blackEntry, whiteEntry] = await Promise.all([
      Blacklist.findOne({
        $or: [{ name }, { allCharacters: name }],
      })
        .collation({ locale: 'en', strength: 2 })
        .lean(),
      Whitelist.findOne({
        $or: [{ name }, { allCharacters: name }],
      })
        .collation({ locale: 'en', strength: 2 })
        .lean(),
    ]);

    if (!blackEntry && !whiteEntry) {
      await interaction.editReply({
        content: `⚠️ No blacklist/whitelist entry found for **${name}**.`,
      });
      return;
    }

    const removeOne = async (entry, type) => {
      const { model, label, icon } = getListContext(type);

      if (!entry.addedByUserId) {
        return `⚠️ **${entry.name}** in ${label} is a legacy entry without owner metadata, so it cannot be removed with this command.`;
      }

      if (entry.addedByUserId !== interaction.user.id) {
        return `⛔ You cannot remove **${entry.name}** from ${label}. Only **${entry.addedByTag || entry.addedByUserId}** (who added it) can remove it.`;
      }

      await model.deleteOne({ _id: entry._id });
      return `${icon} Removed **${entry.name}** from ${label}.`;
    };

    if (blackEntry && whiteEntry) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('remove_black')
          .setLabel('1. Remove in black list')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('remove_white')
          .setLabel('2. Remove in white list')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('remove_both')
          .setLabel('3. Remove both')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.editReply({
        content: `🔎 Found **${name}** in both blacklist and whitelist.\n choose a removal option:`,
        components: [row],
      });

      const reply = await interaction.fetchReply();
      const button = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30000,
      });

      let messages = [];
      if (button.customId === 'remove_black') {
        messages.push(await removeOne(blackEntry, 'black'));
      } else if (button.customId === 'remove_white') {
        messages.push(await removeOne(whiteEntry, 'white'));
      } else {
        messages = await Promise.all([
          removeOne(blackEntry, 'black'),
          removeOne(whiteEntry, 'white'),
        ]);
      }

      await button.update({
        content: messages.join('\n'),
        components: [],
      });
      return;
    }

    if (blackEntry) {
      const message = await removeOne(blackEntry, 'black');
      await interaction.editReply({ content: message });
      return;
    }

    const message = await removeOne(whiteEntry, 'white');
    await interaction.editReply({ content: message });
  } catch (err) {
    console.error('[list] ❌ Remove failed:', err.message);
    await interaction.editReply({
      content: `⚠️ Failed to remove entry: \`${err.message}\``,
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
 * @returns {Promise<{ name: string, reason: string, raid: string, imageUrl: string } | null>}
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
        return {
          name: entry.name,
          reason: entry.reason ?? '',
          raid: entry.raid ?? '',
          imageUrl: entry.imageUrl ?? '',
        };
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
 * Loop name checks against the whitelist collection in Whitelist DB.
 * @param {string[]} names  List of character names to check against the whitelist.
 * @returns {Promise<{ name: string, reason: string, raid: string, imageUrl: string } | null>}
 */
async function handleRosterWhiteListCheck(names) {
  try {
    console.log(`[whitelist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDB();

    for (const charName of names) {
      const entry = await Whitelist.findOne({ name: charName })
        .collation({ locale: 'en', strength: 2 })
        .lean();
      if (entry) {
        console.log(`[whitelist] ✅ "${charName}" is WHITELISTED — reason: ${entry.reason || '(none)'}`);
        return {
          name: entry.name,
          reason: entry.reason ?? '',
          raid: entry.raid ?? '',
          imageUrl: entry.imageUrl ?? '',
        };
      }
    }

    console.log('[whitelist] No whitelisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[whitelist] ❌ Check failed:', err.message, '| code:', err.code, '| name:', err.name);
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
    } else if (commandName === 'list') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'add') {
        await handleListAddCommand(interaction);
      } else if (subcommand === 'remove') {
        await handleListRemoveCommand(interaction);
      }
    } else if (commandName === 'listcheck') {
      await handleListCheckCommand(interaction);
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
