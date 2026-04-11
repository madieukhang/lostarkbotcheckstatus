/**
 * bot.js
 * Entry point for the Lost Ark server-status Discord bot.
 */

import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionType,
  REST,
  Routes,
} from 'discord.js';

import config from './config.js';
import { startMonitor, checkStatus, resetState } from './monitor.js';
import { buildCommands, buildOwnerCommands } from './bot/commands.js';
import { createSystemHandlers } from './bot/handlers/systemHandlers.js';
import { handleRosterCommand } from './bot/handlers/rosterHandler.js';
import { createListHandlers } from './bot/handlers/listHandlers.js';
import { handleSearchCommand } from './bot/handlers/searchHandler.js';
import { setupAutoCheck } from './bot/handlers/autoCheckHandler.js';
import { handleSetupCommand, handleSetupRemoteCommand } from './bot/handlers/setupHandler.js';
import { handleStatsCommand } from './bot/handlers/statsHandler.js';
import { connectDB } from './db.js';
import Blacklist from './models/Blacklist.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const systemHandlers = createSystemHandlers({
  checkStatus,
  resetState,
  client,
});

const listHandlers = createListHandlers({ client });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('[bot] Registering global slash commands…');
    await rest.put(Routes.applicationCommands(client.user.id), { body: buildCommands() });
    console.log('[bot] Global slash commands registered successfully.');

    // Register owner-guild-only commands (guild-specific = instant, invisible to other servers)
    if (config.ownerGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.ownerGuildId),
        { body: buildOwnerCommands() }
      );
      console.log(`[bot] Owner guild commands registered for ${config.ownerGuildId}.`);
    }
  } catch (err) {
    console.error('[bot] Failed to register slash commands:', err.message);
  }
}

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  await connectDB();

  // Sync blacklist indexes (drops old name-only unique, creates compound name+scope+guildId)
  Blacklist.syncIndexes().catch((err) =>
    console.warn('[bot] Blacklist syncIndexes:', err.message)
  );

  await registerCommands();
  startMonitor(client);
  setupAutoCheck(client);
});

client.on('interactionCreate', async (interaction) => {
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('listadd_overwrite:') || interaction.customId.startsWith('listadd_keep:'))
  ) {
    try {
      await listHandlers.handleListAddOverwriteButton(interaction);
    } catch (err) {
      console.error('[list] Overwrite button error:', err.message);
    }
    return;
  }

  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('listadd_approve:') || interaction.customId.startsWith('listadd_reject:'))
  ) {
    try {
      await listHandlers.handleListAddApprovalButton(interaction);
    } catch (err) {
      console.error('[list] Unhandled button approval error:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Failed to process approval action.' }).catch(() => {});
      } else {
        await interaction.reply({ content: '❌ Failed to process approval action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // /list add approval — "📎 View Evidence (Fresh)" button on approver DMs
  if (
    interaction.isButton() &&
    interaction.customId.startsWith('listadd_viewevidence:')
  ) {
    try {
      await listHandlers.handleListAddViewEvidenceButton(interaction);
    } catch (err) {
      console.error('[list] View evidence button error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to load evidence.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // /list multiadd preview Confirm/Cancel buttons
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('multiadd_confirm:') || interaction.customId.startsWith('multiadd_cancel:'))
  ) {
    try {
      await listHandlers.handleMultiaddConfirmButton(interaction);
    } catch (err) {
      console.error('[multiadd] Button handler error:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Failed to process button action.' }).catch(() => {});
      } else {
        await interaction.reply({ content: '❌ Failed to process button action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // /list multiadd bulk approval buttons (DM to Senior)
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('multiaddapprove_approve:') ||
      interaction.customId.startsWith('multiaddapprove_reject:'))
  ) {
    try {
      await listHandlers.handleMultiaddApprovalButton(interaction);
    } catch (err) {
      console.error('[multiadd] Approval button error:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Failed to process approval action.' }).catch(() => {});
      } else {
        await interaction.reply({ content: '❌ Failed to process approval action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // Quick Add: select menu → show modal
  if (interaction.isStringSelectMenu() && interaction.customId === 'quickadd_select') {
    try {
      await listHandlers.handleQuickAddSelect(interaction);
    } catch (err) {
      console.error('[quickadd] Select error:', err.message);
    }
    return;
  }

  // Quick Add: modal submit → process add
  if (interaction.isModalSubmit() && interaction.customId.startsWith('quickadd_modal:')) {
    try {
      await listHandlers.handleQuickAddModal(interaction);
    } catch (err) {
      console.error('[quickadd] Modal error:', err.message);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `⚠️ Failed: \`${err.message}\`` }).catch(() => {});
      } else {
        await interaction.reply({ content: `⚠️ Failed: \`${err.message}\``, ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.type !== InteractionType.ApplicationCommand) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'status') {
      await systemHandlers.handleStatusCommand(interaction);
    } else if (commandName === 'reset') {
      await systemHandlers.handleResetCommand(interaction);
    } else if (commandName === 'roster') {
      await handleRosterCommand(interaction);
    } else if (commandName === 'search') {
      await handleSearchCommand(interaction);
    } else if (commandName === 'list') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'add') {
        await listHandlers.handleListAddCommand(interaction);
      } else if (subcommand === 'edit') {
        await listHandlers.handleListEditCommand(interaction);
      } else if (subcommand === 'remove') {
        await listHandlers.handleListRemoveCommand(interaction);
      } else if (subcommand === 'view') {
        await listHandlers.handleListViewCommand(interaction);
      } else if (subcommand === 'trust') {
        await listHandlers.handleListTrustCommand(interaction);
      } else if (subcommand === 'multiadd') {
        await listHandlers.handleListMultiaddCommand(interaction);
      }
    } else if (commandName === 'listcheck') {
      await listHandlers.handleListCheckCommand(interaction);
    } else if (commandName === 'lastats') {
      await handleStatsCommand(interaction);
    } else if (commandName === 'lasetup') {
      await handleSetupCommand(interaction);
    } else if (commandName === 'laremote') {
      await handleSetupRemoteCommand(interaction);
    } else if (commandName === 'lahelp') {
      const lang = interaction.options.getString('lang') || 'en';

      const helpLines = lang === 'vn' ? [
        '**📋 Danh sách lệnh:**',
        '',
        '`/status` — Xem trạng thái server Lost Ark',
        '`/reset` — Reset trạng thái đã lưu',
        '',
        '`/roster tên [deep]` — Tra cứu roster + theo dõi ilvl. `deep:true` quét alt qua Stronghold',
        '`/search tên [min_ilvl] [max_ilvl] [class]` — Tìm tên tương tự với bộ lọc',
        '',
        '`/list add type tên lý_do [raid] [logs] [image] [scope]` — Thêm vào blacklist/whitelist/watchlist. Scope: global/server (chỉ blacklist)',
        '`/list edit tên [reason] [type] [raid] [logs] [image] [scope]` — Sửa entry đã có. Scope chỉ áp dụng cho blacklist (promote/demote local↔global)',
        '`/list remove tên` — Xoá entry khỏi danh sách',
        '`/list view type [scope]` — Xem danh sách (type: all/black/white/watch/trusted, scope: all/global/server)',
        '`/list trust action tên [reason]` — Quản lý danh sách uy tín (add/remove, chỉ officer)',
        '`/list multiadd action [file]` — 📦 **Bulk add** qua Excel template (xem chi tiết ở dưới)',
        '',
        '`/listcheck image` — Trích tên từ ảnh chụp, kiểm tra với tất cả danh sách',
        '',
        '`/lasetup autochannel #channel` — Đặt kênh tự động kiểm tra ảnh',
        '`/lasetup notifychannel #channel` — Đặt kênh nhận thông báo',
        '`/lasetup view` — Xem cấu hình hiện tại',
        '`/lasetup off` — Bật/tắt nhận thông báo từ server khác',
        '`/lasetup defaultscope global/server` — Đặt scope mặc định cho blacklist',
      ] : [
        '**📋 Available Commands:**',
        '',
        '`/status` — Show live server status for all monitored servers',
        '`/reset` — Reset the stored status state',
        '',
        '`/roster name [deep]` — Fetch roster + progression tracking + list check. `deep:true` for Stronghold alt scan',
        '`/search name [min_ilvl] [max_ilvl] [class]` — Search similar names with filters',
        '',
        '`/list add type name reason [raid] [logs] [image] [scope]` — Add to blacklist/whitelist/watchlist. Scope: global/server (blacklist only)',
        '`/list edit name [reason] [type] [raid] [logs] [image] [scope]` — Edit an existing entry. Scope only applies to blacklist (promote/demote local↔global)',
        '`/list remove name` — Remove an entry from a list',
        '`/list view type [scope]` — View entries (type: all/black/white/watch/trusted, scope: all/global/server)',
        '`/list trust action name [reason]` — Manage trusted list (add/remove, officer only)',
        '`/list multiadd action [file]` — 📦 **Bulk add** via Excel template (see details below)',
        '',
        '`/listcheck image` — Check names from screenshot against all lists',
        '',
        '`/lasetup autochannel #channel` — Set auto-check channel for this server',
        '`/lasetup notifychannel #channel` — Set notification channel for this server',
        '`/lasetup view` — View current channel configuration',
        '`/lasetup off` — Toggle global list notifications on/off',
        '`/lasetup defaultscope global/server` — Set default blacklist scope for /list add',
      ];

      // Owner-only commands — only show in owner server
      if (interaction.guild?.id === config.ownerGuildId) {
        helpLines.push(
          '',
          lang === 'vn' ? '**🛰️ Chỉ Owner Server:**' : '**🛰️ Owner Server Only:**',
          '`/lastats` — ' + (lang === 'vn' ? 'Thống kê bot' : 'Show bot usage statistics'),
          '`/laremote action [guild] [scope] [channel]` — ' + (lang === 'vn'
            ? 'Senior: điều khiển config từ xa (view / off / defaultscope / evidencechannel / syncimages)'
            : 'Senior: remote config dashboard (view / off / defaultscope / evidencechannel / syncimages)'),
          '`/laremote action:evidencechannel channel:#...` — ' + (lang === 'vn'
            ? 'Đặt kênh lưu ảnh evidence (bot rehost vào đây để tránh CDN expire ~24h)'
            : 'Set evidence storage channel (bot rehosts here to defeat CDN ~24h expiry)'),
          '`/laremote action:syncimages` — ' + (lang === 'vn'
            ? 'Migrate ảnh legacy (pre-v0.5.2) sang rehost storage. Cần set `evidencechannel` trước. Idempotent. Xem chi tiết flow ở dưới'
            : 'Migrate legacy (pre-v0.5.2) images to rehost storage. Requires `evidencechannel` set first. Idempotent. See detailed flow below'),
        );
      }

      // Detailed /list multiadd embed — separate from the main command list
      // because this feature has a multi-step flow that needs more explanation
      // than a one-liner. See CHANGELOG v0.5.1 for the feature spec.
      const multiaddEmbed = lang === 'vn'
        ? new EmbedBuilder()
            .setTitle('📦 /list multiadd — Bulk Add qua Excel')
            .setDescription(
              'Thêm **tối đa 30 entries** cùng lúc vào blacklist/whitelist/watchlist ' +
                'bằng 1 file Excel, thay vì gõ `/list add` từng người một.'
            )
            .setColor(0x5865f2)
            .addFields(
              {
                name: '📥 Cách sử dụng (4 bước)',
                value: [
                  '**1.** `/list multiadd action:template` → Bot gửi file template trắng',
                  '**2.** Mở file Excel, xoá dòng ví dụ màu vàng, điền data (tối đa 30 dòng)',
                  '**3.** `/list multiadd action:file file:<file của bạn>` → Bot hiển thị preview',
                  '**4.** Click **✅ Confirm** để add, hoặc **✖️ Cancel** để huỷ',
                ].join('\n'),
                inline: false,
              },
              {
                name: '📋 Các cột của template',
                value: [
                  '**Bắt buộc:** `name`, `type`, `reason`',
                  '**Tuỳ chọn:** `raid`, `logs`, `image`, `scope`',
                  '• `type` (dropdown): `black` / `white` / `watch`',
                  '• `scope` (dropdown): `global` / `server` — chỉ cho blacklist',
                  '• `logs` và `image` phải là URL (`https://...`)',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🔐 Quyền & Flow duyệt',
                value: [
                  '**Officer / Senior** → Confirm xong là batch chạy ngay, có progress bar',
                  '**Member thường** → batch gửi lên **Senior qua 1 DM duy nhất** (không spam mỗi row 1 DM)',
                  'Senior click Approve → batch chạy + notify requester trong channel gốc',
                  'Senior click Reject → requester được báo bị reject',
                  'Chỉ người upload mới click được Confirm/Cancel',
                ].join('\n'),
                inline: false,
              },
              {
                name: '📏 Giới hạn & Quy tắc',
                value: [
                  '• Tối đa **30 rows** mỗi file',
                  '• File size ≤ **1 MB**, chỉ `.xlsx`',
                  '• Preview hết hạn sau **5 phút**',
                  '• Tái sử dụng luật của `/list add`: ilvl ≥ 1700, trusted bị skip, duplicate check',
                  '• Rows lỗi được liệt kê ở preview nhưng **không block** các row valid',
                  '• Duplicate trong cùng file (case-insensitive) sẽ bị reject',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🤔 Các trường hợp đặc biệt',
                value: [
                  '• **Tên đã có trong list** → `⚠️ Skipped` với reason `"duplicate (already in list)"`',
                  '• **Tên không tồn tại** (no roster) → `⚠️ Skipped` với reason `"No roster found for..."`',
                  '• **Trusted user** → `⚠️ Skipped` tự động (exact match hoặc alt qua roster)',
                  '• **ilvl < 1700** → `⚠️ Skipped` với reason `"has item level X (below 1700)"`',
                  '• **Lỗi runtime** (network/DB) → `❌ Failed` với error message',
                  '• **Quan trọng:** lỗi 1 row **KHÔNG block** các row khác — batch chạy đến hết',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🖼️ Ảnh evidence',
                value:
                  'Excel **không hỗ trợ** embedded image. Upload screenshot lên Discord trước, ' +
                  'right-click → Copy Link, rồi paste URL vào cột `image`.',
                inline: false,
              }
            )
            .setFooter({ text: 'Phần chi tiết riêng — các lệnh khác ở trên' })
        : new EmbedBuilder()
            .setTitle('📦 /list multiadd — Bulk Add via Excel')
            .setDescription(
              'Add **up to 30 entries** at once to blacklist/whitelist/watchlist ' +
                'via a single Excel file, instead of running `/list add` one at a time.'
            )
            .setColor(0x5865f2)
            .addFields(
              {
                name: '📥 How to use (4 steps)',
                value: [
                  '**1.** `/list multiadd action:template` → Bot sends a blank template file',
                  '**2.** Open in Excel, delete the yellow example row, fill in up to 30 rows',
                  '**3.** `/list multiadd action:file file:<your file>` → Bot shows a preview',
                  '**4.** Click **✅ Confirm** to proceed, or **✖️ Cancel** to abort',
                ].join('\n'),
                inline: false,
              },
              {
                name: '📋 Template columns',
                value: [
                  '**Required:** `name`, `type`, `reason`',
                  '**Optional:** `raid`, `logs`, `image`, `scope`',
                  '• `type` (dropdown): `black` / `white` / `watch`',
                  '• `scope` (dropdown): `global` / `server` — blacklist only',
                  '• `logs` and `image` must be URLs (`https://...`)',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🔐 Permission & Approval Flow',
                value: [
                  '**Officer / Senior** → batch runs immediately after Confirm, with progress updates',
                  '**Regular member** → batch sent to **Senior as ONE DM** (no spam per row)',
                  'Senior clicks Approve → batch runs + requester notified in origin channel',
                  'Senior clicks Reject → requester notified of rejection',
                  'Only the original uploader can click Confirm/Cancel',
                ].join('\n'),
                inline: false,
              },
              {
                name: '📏 Limits & Rules',
                value: [
                  '• Max **30 rows** per file',
                  '• File size ≤ **1 MB**, `.xlsx` only',
                  '• Preview expires after **5 minutes**',
                  '• Reuses `/list add` rules: ilvl ≥ 1700, trusted users skipped, duplicate check',
                  '• Failed rows listed in preview but **do not block** valid rows',
                  '• Duplicate names within the same file (case-insensitive) are rejected',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🤔 Edge Cases',
                value: [
                  '• **Name already in list** → `⚠️ Skipped` with reason `"duplicate (already in list)"`',
                  '• **Name doesn\'t exist** (no roster) → `⚠️ Skipped` with reason `"No roster found for..."`',
                  '• **Trusted user** → auto-`⚠️ Skipped` (exact match or alt via roster)',
                  '• **ilvl < 1700** → `⚠️ Skipped` with reason `"has item level X (below 1700)"`',
                  '• **Runtime error** (network/DB) → `❌ Failed` with error message',
                  '• **Important:** one row failing does **NOT block** other rows — batch runs to completion',
                ].join('\n'),
                inline: false,
              },
              {
                name: '🖼️ Evidence images',
                value:
                  "Excel doesn't support embedded images. Upload the screenshot to Discord first, " +
                  'right-click → Copy Link, then paste the URL into the `image` column.',
                inline: false,
              }
            )
            .setFooter({ text: 'Detailed section — see the main command list above' });

      // Detailed /laremote action:syncimages embed — only shown when the user
      // is in the owner guild (since the command is Senior-only). Mirrors the
      // multiaddEmbed pattern: dedicated explanation for a complex one-shot
      // operation that has prerequisites and side effects worth understanding
      // BEFORE the senior runs it.
      const isOwnerGuild = interaction.guild?.id === config.ownerGuildId;
      const syncImagesEmbed = isOwnerGuild
        ? (lang === 'vn'
            ? new EmbedBuilder()
                .setTitle('🔄 /laremote action:syncimages — Migrate ảnh legacy')
                .setDescription(
                  'One-shot migration cho **entries cũ** có ảnh được lưu dạng URL trực tiếp ' +
                    '(trước v0.5.2 rehost). Bot tải lại ảnh và upload vào evidence channel ' +
                    'để URL không bao giờ expire nữa.'
                )
                .setColor(0x5865f2)
                .addFields(
                  {
                    name: '✅ Prerequisites',
                    value: [
                      '**1.** `/laremote action:evidencechannel channel:#...` đã được set',
                      '**2.** Bot có quyền `Send Messages` + `Attach Files` trong channel đó',
                      '**3.** Senior account chạy lệnh (chỉ Senior mới có quyền `/laremote`)',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '🔄 Flow per entry (~1.2-1.5s mỗi cái)',
                    value: [
                      '**1.** Detect URL host: Discord CDN hay external (Imgur, etc.)',
                      '**2.** Discord URL → gọi `attachments/refresh-urls` lấy chữ ký mới',
                      '       External URL → dùng trực tiếp, không cần refresh',
                      '**3.** Download file → upload vào evidence channel với audit metadata',
                      '**4.** Compare-and-swap update DB: clear `imageUrl`, set `imageMessageId/imageChannelId`',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '⚠️ Side effects (đọc trước khi chạy!)',
                    value: [
                      '• Evidence channel sẽ nhận **1 message mới mỗi entry** trong vòng vài phút',
                      '• Với 100 entries → ~2-3 phút runtime + 100 messages spam channel',
                      '• Khuyến nghị: **mute channel** trước, chạy off-hours nếu nhiều entries',
                      '• Idempotent: chạy lại an toàn, entries đã migrate sẽ skip tự động',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '📊 Result counters',
                    value: [
                      '**✅ Synced** — entry migrate thành công, có rehost refs mới',
                      '**⚠️ Skipped (dead URLs)** — file gốc đã bị xóa, không recover được',
                      '**🔀 Skipped (raced)** — entry vừa bị edit/migrate bởi nguồn khác',
                      '**❌ Failed** — lỗi infra (channel down, rate limit, etc.) — retry được',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '🛟 Khi gặp vấn đề',
                    value: [
                      '• `Failed > 0` → check log Railway, có thể retry sau',
                      '• `Skipped (dead)` → entries không recover được, cân nhắc remove + add lại',
                      '• `Skipped (raced)` → có orphan upload trong channel, log warn cho biết location',
                      '• Mọi case đều **không mất data** — entries skipped không bị touch',
                    ].join('\n'),
                    inline: false,
                  }
                )
                .setFooter({ text: 'Owner-only · added v0.5.7, race-safe + external URL handling v0.5.8' })
            : new EmbedBuilder()
                .setTitle('🔄 /laremote action:syncimages — Legacy Image Migration')
                .setDescription(
                  'One-shot migration for **legacy entries** whose evidence is stored as a ' +
                    'direct URL (created before v0.5.2 rehost). Bot re-downloads each image ' +
                    'and re-uploads it to the evidence channel so the URL never expires again.'
                )
                .setColor(0x5865f2)
                .addFields(
                  {
                    name: '✅ Prerequisites',
                    value: [
                      '**1.** `/laremote action:evidencechannel channel:#...` already set',
                      '**2.** Bot has `Send Messages` + `Attach Files` permission in that channel',
                      '**3.** Run from a Senior account (only Senior has `/laremote` permission)',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '🔄 Flow per entry (~1.2-1.5s each)',
                    value: [
                      '**1.** Detect URL host: Discord CDN vs external (Imgur, etc.)',
                      '**2.** Discord URL → call `attachments/refresh-urls` for fresh signature',
                      '       External URL → use as-is, no refresh needed',
                      '**3.** Download file → upload to evidence channel with audit metadata',
                      '**4.** Compare-and-swap DB update: clear `imageUrl`, set `imageMessageId/imageChannelId`',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '⚠️ Side effects (read before running!)',
                    value: [
                      '• Evidence channel will receive **1 new message per entry** within minutes',
                      '• 100 entries → ~2-3 min runtime + 100 messages flooding the channel',
                      '• Recommended: **mute channel** first, run off-hours for large batches',
                      '• Idempotent: safe to re-run, already-migrated entries are auto-skipped',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '📊 Result counters',
                    value: [
                      '**✅ Synced** — entry migrated successfully, has new rehost refs',
                      '**⚠️ Skipped (dead URLs)** — original file deleted, cannot recover',
                      '**🔀 Skipped (raced)** — entry was edited/migrated by another source',
                      '**❌ Failed** — infra error (channel down, rate limit, etc.) — retryable',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '🛟 Troubleshooting',
                    value: [
                      '• `Failed > 0` → check Railway logs, can retry later',
                      '• `Skipped (dead)` → entries unrecoverable, consider remove + re-add',
                      '• `Skipped (raced)` → orphan upload in channel, warn log shows location',
                      '• In all cases: **no data loss** — skipped entries are untouched',
                    ].join('\n'),
                    inline: false,
                  }
                )
                .setFooter({ text: 'Owner-only · added v0.5.7, race-safe + external URL handling v0.5.8' }))
        : null;

      // Assemble embeds list: multiaddEmbed always, syncImagesEmbed only for owner guild
      const helpEmbeds = [multiaddEmbed];
      if (syncImagesEmbed) helpEmbeds.push(syncImagesEmbed);

      await interaction.reply({
        content: helpLines.join('\n'),
        embeds: helpEmbeds,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error(`[bot] Unhandled error in /${commandName}:`, err);

    const reply = { content: '❌ An unexpected error occurred.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err);
  process.exit(1);
});

client.login(config.token);
