/**
 * setupHandler.js
 * Handles /lasetup command for per-guild channel configuration.
 * Allows server admins to set auto-check and notification channels
 * without needing to modify environment variables.
 */

import { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, AttachmentBuilder } from 'discord.js';
import { connectDB } from '../db.js';
import config from '../config.js';
import GuildConfig from '../models/GuildConfig.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import Watchlist from '../models/Watchlist.js';
import { invalidateGuildConfig } from '../utils/scope.js';
import { rehostImage } from '../utils/imageRehost.js';

/**
 * Check if the bot has required permissions in a channel.
 * @param {import('discord.js').GuildChannel} channel
 * @param {import('discord.js').Guild} guild
 * @returns {{ ok: boolean, missing: string[] }}
 */
function checkBotPermissions(channel, guild) {
  const botMember = guild.members.me;
  if (!botMember) return { ok: false, missing: ['Cannot resolve bot member'] };

  const perms = channel.permissionsFor(botMember);
  const required = [
    { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
    { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
  ];

  const missing = required.filter((r) => !perms.has(r.flag)).map((r) => r.name);
  return { ok: missing.length === 0, missing };
}

/**
 * Send a test message to verify the channel is working.
 * @param {import('discord.js').TextChannel} channel
 * @param {string} purpose - "auto-check" or "notification"
 * @returns {Promise<boolean>}
 */
async function sendTestMessage(channel, purpose) {
  try {
    const msg = await channel.send({
      content: `✅ **Bot connected!** This channel is now set as the **${purpose}** channel via \`/lasetup\`.`,
    });
    // Auto-delete test message after 30 seconds to keep channel clean
    setTimeout(() => msg.delete().catch(() => {}), 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle /lasetup autochannel #channel
 */
async function handleSetupAutoChannel(interaction) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: '❌ Please select a **text channel**.',
      ephemeral: true,
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild);
  if (!ok) {
    await interaction.reply({
      content: `❌ Bot is missing permissions in <#${channel.id}>:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nPlease fix channel permissions and try again.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  // Warn if same channel as notify (allow but warn)
  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const sameAsNotify = existing?.listNotifyChannelId === channel.id;

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        autoCheckChannelId: channel.id,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  // Send test message to verify channel works
  const testOk = await sendTestMessage(channel, 'auto-check');

  const warning = sameAsNotify ? '\n⚠️ This is the same channel as notifications — consider using separate channels to avoid clutter.' : '';

  await interaction.editReply({
    content: testOk
      ? `✅ Auto-check channel set to <#${channel.id}>.\nBot will automatically check screenshots posted in this channel.${warning}\n\n*A test message was sent to verify — it will auto-delete in 30s.*`
      : `✅ Auto-check channel set to <#${channel.id}>.${warning}\n⚠️ Could not send a test message — please verify bot permissions.`,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) set autoCheckChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup notifychannel #channel
 */
async function handleSetupNotifyChannel(interaction) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: '❌ Please select a **text channel**.',
      ephemeral: true,
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild);
  if (!ok) {
    await interaction.reply({
      content: `❌ Bot is missing permissions in <#${channel.id}>:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nPlease fix channel permissions and try again.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  // Warn if same channel as auto-check (allow but warn)
  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const sameAsAutoCheck = existing?.autoCheckChannelId === channel.id;

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        listNotifyChannelId: channel.id,
        globalNotifyEnabled: true, // auto re-enable when setting a notify channel
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  // Send test message to verify channel works
  const testOk = await sendTestMessage(channel, 'notification');
  const warning = sameAsAutoCheck ? '\n⚠️ This is the same channel as auto-check — consider using separate channels to avoid clutter.' : '';

  await interaction.editReply({
    content: testOk
      ? `✅ Notification channel set to <#${channel.id}>.\nList add/remove actions will be broadcast here.${warning}\n\n*A test message was sent to verify — it will auto-delete in 30s.*`
      : `✅ Notification channel set to <#${channel.id}>.${warning}\n⚠️ Could not send a test message — please verify bot permissions.`,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) set listNotifyChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup off — toggle global notifications on/off
 */
async function handleSetupOff(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id });

  // Current state (default true if no config exists)
  const currentlyEnabled = existing?.globalNotifyEnabled ?? true;
  const newState = !currentlyEnabled;

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        globalNotifyEnabled: newState,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (newState) {
    await interaction.editReply({
      content: '🔔 Global list notifications **enabled** for this server.\nYou will receive broadcast notifications when entries are added/removed/edited on other servers.',
    });
  } else {
    await interaction.editReply({
      content: '🔕 Global list notifications **disabled** for this server.\nYou will no longer receive broadcast notifications from other servers.\n\nRun `/lasetup off` again or `/lasetup notifychannel #channel` to re-enable.',
    });
  }

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup view
 */
async function handleSetupView(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  const guildConfig = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();

  const autoCheckDb = guildConfig?.autoCheckChannelId;
  const notifyDb = guildConfig?.listNotifyChannelId;

  // Env var fallback info
  const autoCheckEnv = config.autoCheckChannelIds;
  const notifyEnv = config.listNotifyChannelIds;

  const lines = [];

  // Auto-check channel
  lines.push('**📸 Auto-check channel:**');
  if (autoCheckDb) {
    lines.push(`  → <#${autoCheckDb}> *(set via /lasetup)*`);
  } else if (autoCheckEnv.length > 0) {
    lines.push(`  → ${autoCheckEnv.map((id) => `<#${id}>`).join(', ')} *(from env vars)*`);
  } else {
    lines.push('  → *Not configured*');
  }

  lines.push('');

  // Notify channel
  lines.push('**🔔 Notification channel:**');
  if (notifyDb) {
    lines.push(`  → <#${notifyDb}> *(set via /lasetup)*`);
  } else if (notifyEnv.length > 0) {
    lines.push(`  → ${notifyEnv.map((id) => `<#${id}>`).join(', ')} *(from env vars)*`);
  } else {
    lines.push('  → *Not configured*');
  }

  // Global notification status
  const notifyEnabled = guildConfig?.globalNotifyEnabled ?? true;
  lines.push('');
  lines.push(`**📡 Global notifications:** ${notifyEnabled ? '🔔 Enabled' : '🔕 Disabled'}`);
  if (!notifyEnabled) {
    lines.push('  → *This server will not receive broadcast notifications from other servers*');
  }

  // Default blacklist scope
  const defaultScope = guildConfig?.defaultBlacklistScope || 'global';
  const scopeEmoji = defaultScope === 'server' ? '🔒' : '🌐';
  lines.push('');
  lines.push(`**${scopeEmoji} Default blacklist scope:** ${defaultScope}`);
  lines.push(`  → *\`/list add type:black\` without scope will default to ${defaultScope}*`);

  if (guildConfig?.updatedAt) {
    lines.push('');
    lines.push(`Last updated: <t:${Math.floor(new Date(guildConfig.updatedAt).getTime() / 1000)}:R> by ${guildConfig.updatedByTag || 'Unknown'}`);
  }

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Bot Configuration')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

export async function handleSetupCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: '❌ This command can only be used in a server.',
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  // Remote is senior-only (checked inside handler). All others need ManageGuild.
  if (subcommand !== 'remote') {
    const hasManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!hasManageGuild) {
      await interaction.reply({ content: '❌ You need **Manage Server** permission to use this command.', ephemeral: true });
      return;
    }
  }

  if (subcommand === 'autochannel') {
    await handleSetupAutoChannel(interaction);
  } else if (subcommand === 'notifychannel') {
    await handleSetupNotifyChannel(interaction);
  } else if (subcommand === 'off') {
    await handleSetupOff(interaction);
  } else if (subcommand === 'defaultscope') {
    await handleSetupDefaultScope(interaction);
  } else if (subcommand === 'view') {
    await handleSetupView(interaction);
  }
}

/**
 * Handle /lasetup defaultscope global|server
 */
async function handleSetupDefaultScope(interaction) {
  const scope = interaction.options.getString('scope', true);

  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        defaultBlacklistScope: scope,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  const emoji = scope === 'server' ? '🔒' : '🌐';
  await interaction.editReply({
    content: `${emoji} Default blacklist scope set to **${scope}**.\nWhen \`/list add type:black\` is used without specifying scope, entries will default to **${scope}**.`,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) defaultBlacklistScope → ${scope} by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup remote — Senior-only remote config management
 */
export async function handleSetupRemoteCommand(interaction) {
  const seniorIds = config.seniorApproverIds || [];
  if (!seniorIds.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ Only seniors can use remote config management.', ephemeral: true });
    return;
  }

  const action = interaction.options.getString('action', true);
  const targetGuildId = interaction.options.getString('guild') || '';
  const scopeValue = interaction.options.getString('scope') || '';
  const channelOpt = interaction.options.getChannel('channel');

  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  // Helper: resolve guild name from ID
  async function resolveGuildName(gid) {
    try { return (await interaction.client.guilds.fetch(gid)).name; } catch { return null; }
  }

  // ── ACTION: view ─────────────────────────────────────────
  if (action === 'view') {
    const allGuilds = [...interaction.client.guilds.cache.values()];
    const allConfigs = await GuildConfig.find({}).lean();
    const configMap = new Map(allConfigs.map((gc) => [gc.guildId, gc]));

    if (allGuilds.length === 0) {
      await interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle('🛰️ Remote Control — Dashboard').setDescription('*Bot is not in any server.*').setColor(0x95a5a6),
      ] });
      return;
    }

    function buildServerEmbed(guild) {
      const gc = configMap.get(guild.id);
      const isOwner = guild.id === config.ownerGuildId;
      const notify = gc?.globalNotifyEnabled === false ? '🔕 Disabled' : '🔔 Enabled';
      const scope = gc?.defaultBlacklistScope || 'global';
      const scopeDisplay = scope === 'server' ? '🔒 Server (Local)' : '🌐 Global';
      const autoCheck = gc?.autoCheckChannelId ? `<#${gc.autoCheckChannelId}>` : '*Not set*';
      const notifyCh = gc?.listNotifyChannelId ? `<#${gc.listNotifyChannelId}>` : '*Not set*';
      const updated = gc?.updatedAt ? `<t:${Math.floor(new Date(gc.updatedAt).getTime() / 1000)}:R>` : '—';
      const configured = gc ? '✅' : '⚪';

      const embed = new EmbedBuilder()
        .setTitle(`${isOwner ? '👑' : '🖥️'} ${guild.name} ${configured}`)
        .setDescription(`\`${guild.id}\`${isOwner ? ' — **Owner Server**' : ''}${!gc ? ' — *No config yet*' : ''}`)
        .addFields(
          { name: '📡 Global Notify', value: notify, inline: true },
          { name: '🎯 Default Scope', value: scopeDisplay, inline: true },
          { name: '📸 Auto-check', value: autoCheck, inline: true },
          { name: '🔔 Notify Channel', value: notifyCh, inline: true },
          { name: '🕐 Last Updated', value: updated, inline: true },
          { name: '👤 Updated By', value: gc?.updatedByTag || '—', inline: true },
        )
        .setColor(isOwner ? 0xf1c40f : gc ? 0x5865f2 : 0x95a5a6);

      // Bot-wide settings only shown on owner guild card
      if (isOwner) {
        const evidenceCh = gc?.evidenceChannelId
          ? `<#${gc.evidenceChannelId}>`
          : '*Not set — images use legacy URL (expire ~24h)*';
        embed.addFields({
          name: '🖼️ Evidence Channel (bot-wide)',
          value: evidenceCh,
          inline: false,
        });
      }

      return embed;
    }

    // Owner embed always pinned on top
    const ownerGuild = allGuilds.find((g) => g.id === config.ownerGuildId);
    const otherGuilds = allGuilds.filter((g) => g.id !== config.ownerGuildId);
    const ownerEmbed = ownerGuild ? buildServerEmbed(ownerGuild) : null;

    // Paginate other servers (max 9 per page since owner takes 1 slot)
    const perPage = 3;
    const totalPages = Math.max(1, Math.ceil(otherGuilds.length / perPage));
    let currentPage = 0;

    function buildPage(page) {
      const start = page * perPage;
      const pageGuilds = otherGuilds.slice(start, start + perPage);
      const embeds = ownerEmbed ? [ownerEmbed] : [];
      for (const guild of pageGuilds) embeds.push(buildServerEmbed(guild));
      return embeds;
    }

    function buildNav(page) {
      if (totalPages <= 1) return [];
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('remote_prev').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('remote_page').setLabel(`${page + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('remote_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      )];
    }

    const msg = await interaction.editReply({ embeds: buildPage(0), components: buildNav(0) });

    if (totalPages <= 1) return;

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120_000 });
    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) { await i.reply({ content: '❌', ephemeral: true }); return; }
      if (i.customId === 'remote_prev') currentPage = Math.max(0, currentPage - 1);
      else if (i.customId === 'remote_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
      await i.update({ embeds: buildPage(currentPage), components: buildNav(currentPage) });
    });
    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
    return;
  }

  // ── ACTION: evidencechannel ──────────────────────────────
  // Bot-wide setting (not per-guild) — stored on owner GuildConfig.
  // Sets where the bot rehosts /list add evidence images for permanent storage.
  if (action === 'evidencechannel') {
    if (!config.ownerGuildId) {
      await interaction.editReply({
        content: '❌ `OWNER_GUILD_ID` is not configured. Set it in env vars first.',
      });
      return;
    }

    if (!channelOpt) {
      await interaction.editReply({
        content: '❌ Provide `channel:` option for this action. Pick the hidden channel where evidence images will be stored.',
      });
      return;
    }

    if (!channelOpt.isTextBased?.()) {
      await interaction.editReply({
        content: `❌ Channel <#${channelOpt.id}> is not a text channel.`,
      });
      return;
    }

    // Verify bot can post + read in this channel (best-effort permission check)
    const me = channelOpt.guild?.members?.me;
    if (me) {
      const perms = channelOpt.permissionsFor(me);
      const need = ['ViewChannel', 'SendMessages', 'AttachFiles', 'ReadMessageHistory'];
      const missing = need.filter((p) => !perms?.has(p));
      if (missing.length > 0) {
        await interaction.editReply({
          content: `❌ Bot is missing permissions in <#${channelOpt.id}>: ${missing.join(', ')}.\nGrant these and try again.`,
        });
        return;
      }
    }

    // Persist to OWNER guild's GuildConfig
    await GuildConfig.findOneAndUpdate(
      { guildId: config.ownerGuildId },
      {
        $set: {
          evidenceChannelId: channelOpt.id,
          updatedByUserId: interaction.user.id,
          updatedByTag: interaction.user.tag,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateGuildConfig(config.ownerGuildId);

    const embed = new EmbedBuilder()
      .setTitle('🖼️ Evidence Channel Updated')
      .setDescription(
        `New /list add image attachments will be rehosted to <#${channelOpt.id}> ` +
        `for permanent storage. Existing entries are unaffected.`
      )
      .addFields(
        { name: 'Channel', value: `<#${channelOpt.id}>`, inline: true },
        { name: 'Channel ID', value: `\`${channelOpt.id}\``, inline: true },
        { name: 'Server', value: channelOpt.guild?.name || '*Unknown*', inline: true },
      )
      .setColor(0x5865f2)
      .setFooter({ text: `Set by ${interaction.user.tag} · bot-wide setting` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    console.log(`[lasetup] Remote: evidenceChannelId → ${channelOpt.id} by ${interaction.user.tag}`);
    return;
  }

  // ── ACTION: syncimages ───────────────────────────────────
  // One-shot migration: scan all 3 lists for legacy entries (have imageUrl
  // but no imageMessageId), refresh the original CDN URL via Discord's
  // attachments/refresh-urls endpoint, download the freshly-signed URL,
  // re-upload to the evidence channel, and persist rehost refs back to the
  // entry. Idempotent — re-running skips already-migrated entries because
  // the query filter requires imageUrl set AND imageMessageId empty.
  //
  // Why this works: Discord CDN files persist as long as the original
  // message exists; only the URL signature expires. The refresh-urls
  // endpoint asks Discord to issue a new signature for the same file.
  // This is the same mechanism Discord client uses internally when you
  // click an old expired URL inside Discord — we just call it explicitly.
  if (action === 'syncimages') {
    // Validate evidence channel is configured (otherwise rehost fails for all entries)
    const ownerCfg = await GuildConfig.findOne({ guildId: config.ownerGuildId }).lean();
    if (!ownerCfg?.evidenceChannelId) {
      await interaction.editReply({
        content: '❌ Evidence channel is not configured. Run `/laremote action:evidencechannel channel:#...` first.',
      });
      return;
    }

    // Scan all 3 lists for legacy entries.
    // Filter: imageUrl is non-empty AND imageMessageId is empty/missing.
    const legacyFilter = {
      imageUrl: { $nin: ['', null] },
      $or: [{ imageMessageId: '' }, { imageMessageId: { $exists: false } }],
    };
    const [blackLegacy, whiteLegacy, watchLegacy] = await Promise.all([
      Blacklist.find(legacyFilter).lean(),
      Whitelist.find(legacyFilter).lean(),
      Watchlist.find(legacyFilter).lean(),
    ]);
    const legacyEntries = [
      ...blackLegacy.map((e) => ({ entry: e, model: Blacklist, type: 'black' })),
      ...whiteLegacy.map((e) => ({ entry: e, model: Whitelist, type: 'white' })),
      ...watchLegacy.map((e) => ({ entry: e, model: Watchlist, type: 'watch' })),
    ];

    if (legacyEntries.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Sync Images — Nothing to do')
            .setDescription('All entries with images already have rehost refs. Nothing to migrate.')
            .setColor(0x2ecc71)
            .setTimestamp(),
        ],
      });
      return;
    }

    // Initial reply with count, then start the loop.
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔄 Sync Images — Starting')
          .setDescription(`Found **${legacyEntries.length}** legacy entries across all lists. Migrating now…`)
          .addFields(
            { name: 'Blacklist', value: String(blackLegacy.length), inline: true },
            { name: 'Whitelist', value: String(whiteLegacy.length), inline: true },
            { name: 'Watchlist', value: String(watchLegacy.length), inline: true },
          )
          .setColor(0xfee75c)
          .setFooter({ text: 'Each entry: refresh URL → download → rehost. ~1-2s per entry.' })
          .setTimestamp(),
      ],
    });

    // Detect whether a URL is hosted on Discord's CDN. Discord attachment URLs
    // need their signature refreshed via the attachments/refresh-urls endpoint
    // before download; external URLs (Imgur, Postimages, etc.) are downloadable
    // directly and don't have the ?ex=...&hm=... expiry mechanism.
    const isDiscordCdnUrl = (url) => {
      try {
        const u = new URL(url);
        return u.hostname.endsWith('discordapp.com') || u.hostname.endsWith('discordapp.net');
      } catch {
        return false;
      }
    };

    // Stats:
    //   synced       — CAS update succeeded, entry now has rehost refs
    //   skippedDead  — refresh API said file is gone, OR external URL 404'd
    //   skippedRaced — entry was modified between snapshot and CAS write
    //                  (another sync run, /list edit, or /list multiadd
    //                  approval landed in the gap). The new state wins.
    //   failed       — unexpected errors (network, channel down, etc.)
    const stats = { synced: 0, skippedDead: 0, skippedRaced: 0, failed: 0, errors: [] };

    for (let i = 0; i < legacyEntries.length; i++) {
      const { entry, model, type } = legacyEntries[i];

      try {
        // Step 1: Resolve a downloadable URL.
        //   - Discord CDN URL → refresh signature via attachments/refresh-urls
        //   - External URL (Imgur, etc.) → use as-is, no refresh needed
        let downloadUrl = null;
        if (isDiscordCdnUrl(entry.imageUrl)) {
          const refreshResponse = await fetch('https://discord.com/api/v10/attachments/refresh-urls', {
            method: 'POST',
            headers: {
              'Authorization': `Bot ${interaction.client.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ attachment_urls: [entry.imageUrl] }),
          });

          if (!refreshResponse.ok) {
            stats.skippedDead += 1;
            stats.errors.push(`${entry.name}: refresh API returned ${refreshResponse.status}`);
            continue;
          }

          const refreshData = await refreshResponse.json();
          const refreshedUrl = refreshData?.refreshed_urls?.[0]?.refreshed;
          if (!refreshedUrl) {
            stats.skippedDead += 1;
            stats.errors.push(`${entry.name}: refresh returned no URL (file likely deleted)`);
            continue;
          }
          downloadUrl = refreshedUrl;
        } else {
          // External URL — try direct download. rehostImage() will fail
          // gracefully if the URL is dead, and we'll mark as skippedDead below.
          downloadUrl = entry.imageUrl;
        }

        // Step 2: Download the URL and rehost to evidence channel.
        // Uses throwOnError so we get the actual failure message in stats,
        // not a generic "rehost returned null". One automatic retry with a
        // 2s delay handles transient network blips and brief Discord rate
        // limit windows. The first attempt's error is preserved if both fail.
        let rehosted = null;
        let firstAttemptError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            rehosted = await rehostImage(downloadUrl, interaction.client, {
              entryName: entry.name,
              addedBy: `Migration by ${interaction.user.tag}`,
              listType: type,
              throwOnError: true,
            });
            break; // success
          } catch (err) {
            if (attempt === 1) {
              firstAttemptError = err.message;
              // Wait 2s before retry — gives Discord rate-limit a moment to clear
              await new Promise((r) => setTimeout(r, 2000));
            } else {
              // Both attempts failed — classify by error pattern.
              // Key insight from v0.5.10 live run: Discord garbage-collects
              // old attachments from the CDN after ~30-90 days even if the
              // original message still exists. The refresh-urls API can
              // still return a valid-looking URL for these, but downloading
              // yields HTTP 404. There's no way to recover these — they are
              // truly dead, NOT an infrastructure failure. Classify any
              // download failure (HTTP 4xx/5xx or fetch exception) as
              // Skipped (dead URLs), regardless of whether the URL was
              // Discord CDN or external. Only infra-layer errors (channel
              // send failed, permission denied) stay in Failed.
              const errMsg = err.message;
              const isDownloadFailure =
                errMsg.startsWith('download HTTP')
                || errMsg.startsWith('download fetch threw')
                || errMsg.startsWith('download read body');

              if (isDownloadFailure) {
                stats.skippedDead += 1;
                stats.errors.push(`${entry.name}: ${errMsg}`);
              } else {
                stats.failed += 1;
                stats.errors.push(`${entry.name}: ${errMsg}${firstAttemptError && firstAttemptError !== errMsg ? ` (attempt 1: ${firstAttemptError})` : ''}`);
              }
            }
          }
        }
        if (!rehosted) continue;

        // Step 3: Compare-and-swap update. The filter requires the entry to
        // STILL match the legacy snapshot we read at the start (same imageUrl,
        // still no imageMessageId). If anyone else modified the entry in the
        // meantime — another sync run, /list edit, or a /list multiadd
        // approval — the matchedCount is 0 and we skip without overwriting
        // the newer state. The orphan rehost message in the evidence channel
        // is the (rare) cost of this safety.
        const updateResult = await model.updateOne(
          {
            _id: entry._id,
            imageUrl: entry.imageUrl,
            $or: [
              { imageMessageId: '' },
              { imageMessageId: { $exists: false } },
            ],
          },
          {
            $set: {
              imageUrl: '',
              imageMessageId: rehosted.messageId,
              imageChannelId: rehosted.channelId,
            },
          }
        );

        if (updateResult.matchedCount === 1) {
          stats.synced += 1;
        } else {
          stats.skippedRaced += 1;
          stats.errors.push(`${entry.name}: entry changed during sync — orphan rehost left in channel`);
          console.warn(`[syncimages] Race detected for ${entry.name} — CAS update was no-op, orphan upload at ${rehosted.channelId}/${rehosted.messageId}`);
        }
      } catch (err) {
        stats.failed += 1;
        stats.errors.push(`${entry.name}: ${err.message}`);
        console.warn(`[syncimages] Entry ${entry.name} failed:`, err.message);
      }

      // Throttle to avoid hammering Discord API (refresh + upload). Bumped
      // from 200ms to 500ms in v0.5.10 after VHT's first run had 49 entries
      // fail in a row mid-batch, suggesting we were too close to Discord's
      // sustained channel rate limit (5 messages / 5 seconds = 1/s).
      if (i < legacyEntries.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // Progress update every 10 entries (skip very first iteration).
      if ((i + 1) % 10 === 0 && i + 1 < legacyEntries.length) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🔄 Sync Images — In Progress')
              .setDescription(`Processing **${i + 1}/${legacyEntries.length}** entries…`)
              .addFields(
                { name: '✅ Synced', value: String(stats.synced), inline: true },
                { name: '⚠️ Dead URLs', value: String(stats.skippedDead), inline: true },
                { name: '🔀 Raced', value: String(stats.skippedRaced), inline: true },
                { name: '❌ Failed', value: String(stats.failed), inline: true },
              )
              .setColor(0xfee75c)
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    }

    // Final summary
    const summaryColor =
      stats.failed > 0 || stats.skippedDead > 0 || stats.skippedRaced > 0
        ? 0xfee75c
        : 0x2ecc71;
    const summaryEmbed = new EmbedBuilder()
      .setTitle('✅ Sync Images — Complete')
      .setDescription(`Processed **${legacyEntries.length}** legacy entries.`)
      .addFields(
        { name: '✅ Synced', value: String(stats.synced), inline: true },
        { name: '⚠️ Skipped (dead URLs)', value: String(stats.skippedDead), inline: true },
        { name: '🔀 Skipped (raced)', value: String(stats.skippedRaced), inline: true },
        { name: '❌ Failed', value: String(stats.failed), inline: true },
      )
      .setColor(summaryColor)
      .setFooter({ text: `Migration by ${interaction.user.tag} · re-runs are safe (idempotent)` })
      .setTimestamp();

    // Append first 10 errors as a field for debugging
    if (stats.errors.length > 0) {
      const errorLines = stats.errors.slice(0, 10).map((e) => `• ${e}`).join('\n');
      const truncated = stats.errors.length > 10 ? `\n*…and ${stats.errors.length - 10} more*` : '';
      summaryEmbed.addFields({
        name: `Errors (${stats.errors.length})`,
        value: (errorLines + truncated).slice(0, 1024),
        inline: false,
      });
    }

    // If there are many errors, attach a full-detail .txt file so the user
    // can view/search/share all of them instead of just the first 10 in the
    // embed. The embed keeps the quick-glance summary; the file has everything.
    const replyPayload = { embeds: [summaryEmbed] };
    if (stats.errors.length > 10) {
      const errorLines = stats.errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
      const header = [
        `Sync Images — Full Error Report`,
        `Date: ${new Date().toISOString()}`,
        `By: ${interaction.user.tag}`,
        `Total entries: ${legacyEntries.length}`,
        `Synced: ${stats.synced} | Dead: ${stats.skippedDead} | Raced: ${stats.skippedRaced} | Failed: ${stats.failed}`,
        `${'─'.repeat(60)}`,
        '',
      ].join('\n');
      const fullReport = header + errorLines;
      replyPayload.files = [
        new AttachmentBuilder(
          Buffer.from(fullReport, 'utf-8'),
          { name: `syncimages_errors_${new Date().toISOString().slice(0, 10)}.txt` }
        ),
      ];
    }
    await interaction.editReply(replyPayload);
    console.log(`[syncimages] Done by ${interaction.user.tag}: ${stats.synced} synced, ${stats.skippedDead} dead, ${stats.skippedRaced} raced, ${stats.failed} failed`);
    return;
  }

  // ── Need guild ID for off/defaultscope ───────────────────
  if (!targetGuildId) {
    const helpEmbed = new EmbedBuilder()
      .setTitle('❌ Missing Guild ID')
      .setDescription('Use `action:view` first to see all guild IDs, then copy the ID here.')
      .addFields(
        { name: 'Toggle notify', value: '`/laremote action:off guild:<ID>`', inline: false },
        { name: 'Set scope', value: '`/laremote action:defaultscope guild:<ID> scope:server`', inline: false },
        { name: 'Set evidence channel', value: '`/laremote action:evidencechannel channel:#...`', inline: false },
        { name: 'Sync legacy images', value: '`/laremote action:syncimages` (no guild ID needed)', inline: false },
      )
      .setColor(0xed4245);
    await interaction.editReply({ embeds: [helpEmbed] });
    return;
  }

  // Validate target guild — bot must be in it
  const guildName = await resolveGuildName(targetGuildId);
  if (!guildName) {
    const embed = new EmbedBuilder()
      .setTitle('❌ Guild Not Found')
      .setDescription(`Bot is not in a server with ID \`${targetGuildId}\`.\nUse \`action:view\` to see valid guild IDs.`)
      .setColor(0xed4245);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const auditFields = { updatedByUserId: interaction.user.id, updatedByTag: interaction.user.tag };

  // ── ACTION: off ──────────────────────────────────────────
  if (action === 'off') {
    const existing = await GuildConfig.findOne({ guildId: targetGuildId });
    const currentlyEnabled = existing?.globalNotifyEnabled ?? true;
    const newState = !currentlyEnabled;

    await GuildConfig.findOneAndUpdate(
      { guildId: targetGuildId },
      { $set: { globalNotifyEnabled: newState, ...auditFields } },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateGuildConfig(targetGuildId);

    const embed = new EmbedBuilder()
      .setTitle(`${newState ? '🔔' : '🔕'} Remote — Notify ${newState ? 'Enabled' : 'Disabled'}`)
      .addFields(
        { name: 'Server', value: `**${guildName}**\n\`${targetGuildId}\``, inline: true },
        { name: 'Status', value: newState ? '🔔 Receiving broadcasts' : '🔕 Silent — no broadcasts', inline: true },
      )
      .setColor(newState ? 0x2ecc71 : 0xe74c3c)
      .setFooter({ text: `Changed by ${interaction.user.tag} · silent — server not notified` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    console.log(`[lasetup] Remote: ${targetGuildId} globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
    return;
  }

  // ── ACTION: defaultscope ─────────────────────────────────
  if (action === 'defaultscope') {
    if (!scopeValue) {
      await interaction.editReply({ content: '❌ Provide `scope` value (global/server) for this action.' });
      return;
    }

    await GuildConfig.findOneAndUpdate(
      { guildId: targetGuildId },
      { $set: { defaultBlacklistScope: scopeValue, ...auditFields } },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateGuildConfig(targetGuildId);

    const scopeDisplay = scopeValue === 'server' ? '🔒 Server (Local)' : '🌐 Global';
    const embed = new EmbedBuilder()
      .setTitle(`${scopeValue === 'server' ? '🔒' : '🌐'} Remote — Scope Updated`)
      .addFields(
        { name: 'Server', value: `**${guildName}**\n\`${targetGuildId}\``, inline: true },
        { name: 'Default Scope', value: scopeDisplay, inline: true },
      )
      .setColor(scopeValue === 'server' ? 0x9b59b6 : 0x3498db)
      .setFooter({ text: `Changed by ${interaction.user.tag} · silent — server not notified` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    console.log(`[lasetup] Remote: ${targetGuildId} defaultBlacklistScope → ${scopeValue} by ${interaction.user.tag}`);
  }
}
