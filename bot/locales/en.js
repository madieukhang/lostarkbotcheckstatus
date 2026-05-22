const en = {
  language: {
    code: 'en',
    label: 'English',
    nativeShort: 'English',
    flag: '🇬🇧',
  },

  common: {
    pagination: {
      previous: 'Previous',
      next: 'Next',
    },
    actions: {
      approve: 'Approve',
      reject: 'Reject',
      approving: 'Approving...',
      rejecting: 'Rejecting...',
      approved: 'Approved',
      rejected: 'Rejected',
      processed: 'Processed',
      failed: 'Failed',
      blocked: 'Blocked',
      cancel: 'Cancel',
      discard: 'Discard',
      overwrite: 'Overwrite',
      keepExisting: 'Keep Existing',
      keptExisting: 'Kept Existing',
      overwritten: 'Overwritten',
      viewEvidenceFresh: '📎 View Evidence (Fresh)',
      approveAdd: 'Approve · Add {count}',
      confirmAdd: 'Confirm Add {count}',
      confirmAddCompact: 'Confirm · Add {count}',
      savePartial: 'Save partial · {count}',
      continueScan: 'Continue scan',
      stopScan: 'Stop scan',
      stopping: 'Stopping...',
      jumpToResult: 'Jump to result',
      enrichNow: 'Enrich now',
    },
  },

  commands: {
    status: {
      description: 'Show live server status',
    },
    reset: {
      description: 'Reset the stored status state back to default',
    },
    roster: {
      description: 'Fetch roster for a Lost Ark character with progression tracking',
      options: {
        name: 'Character name to look up',
        deep: 'Run Stronghold alt detection scan (slower, finds hidden alts)',
        deepLimit: 'Stronghold scan limit: default env limit, 0 = scan all candidates',
      },
    },
    list: {
      description: 'Manage blacklist/whitelist/watchlist entries',
      subcommands: {
        add: {
          description: 'Add a character to blacklist, whitelist, or watchlist',
          options: {
            type: 'Which list to add to',
            name: 'Character name to add',
            reason: 'Reason for this entry',
            raid: 'Optional raid tag',
            logs: 'Optional lostark.bible logs URL',
            image: 'Optional evidence screenshot',
            scope: 'Global (all servers) or Server (this server only) - blacklist only',
          },
        },
        edit: {
          description: 'Edit an existing list entry (reason, raid, type, scope)',
          options: {
            name: 'Character name to edit',
            reason: 'New reason (leave empty to keep current)',
            type: 'Move to a different list',
            raid: 'New raid tag',
            logs: 'New logs URL',
            image: 'New evidence screenshot',
            scope: 'Promote local->global or demote global->local - blacklist only',
            additionalNames: 'Comma-separated alts to append (officer/owner only, manual filler)',
          },
        },
        remove: {
          description: 'Remove a character from blacklist/whitelist/watchlist',
          options: {
            name: 'Character name to remove',
          },
        },
        view: {
          description: 'View all entries in a list',
          options: {
            type: 'Which list to view',
            scope: 'Filter blacklist by scope (owner server only for all servers)',
          },
        },
        trust: {
          description: 'Manage trusted list - trusted characters cannot be added to any list',
          options: {
            action: 'Add or remove from trusted list',
            name: 'Character name',
            reason: 'Reason for trust (only for add)',
          },
        },
        enrich: {
          description: 'Stronghold deep-scan an existing list entry and append discovered alts',
          options: {
            name: 'Character name with an existing list entry',
            deepLimit: 'Override candidate cap (default = STRONGHOLD_DEEP_CANDIDATE_LIMIT)',
          },
        },
        multiadd: {
          description: 'Bulk add via Excel template - officers auto, members via Senior approval',
          options: {
            action: 'template = download blank template, file = upload filled template',
            file: 'Filled .xlsx file (max 30 rows, required for action:file)',
          },
        },
      },
    },
    search: {
      description: 'Search for a character name with filters and cross-check lists',
      options: {
        name: 'Character name to search',
        minIlvl: 'Minimum item level (default: 1700)',
        maxIlvl: 'Maximum item level',
        class: 'Filter by class',
      },
    },
    evidence: {
      description: 'Direct lookup: show evidence for a listed character (autocomplete-driven)',
      options: {
        name: 'Character name (autocomplete shows entries across all lists)',
        public: 'Broadcast publicly in this channel (officer/senior only; defaults private)',
      },
    },
    check: {
      description: 'Check names from screenshot against all lists',
      options: {
        image: 'Raid waiting room screenshot',
      },
    },
    help: {
      description: 'Show all available Lost Ark bot commands',
      options: {
        lang: 'Language (default: your saved preference)',
      },
    },
    languageSwitch: {
      description: 'Switch the language LoaLogs uses for your responses',
    },
    setup: {
      description: 'Configure bot channels for this server',
      subcommands: {
        autochannel: {
          description: 'Set the channel for auto-checking screenshots',
          options: {
            channel: 'Channel where screenshots will be auto-checked',
          },
        },
        notifychannel: {
          description: 'Set the channel for list add/remove notifications',
          options: {
            channel: 'Channel where list notifications will be sent',
          },
        },
        view: {
          description: 'View current bot channel configuration',
        },
        off: {
          description: 'Toggle global list notifications on/off for this server',
        },
        defaultscope: {
          description: 'Set default blacklist scope for /la-list add (global or server)',
          options: {
            scope: 'Default scope when /la-list add does not specify scope',
          },
        },
      },
    },
    stats: {
      description: 'Show bot usage statistics',
    },
    remote: {
      description: 'Senior: view/control bot config for any server (silent)',
      options: {
        action: 'What to do',
        guild: 'Target server ID (required for off/defaultscope)',
        scope: 'Scope value (for defaultscope action only)',
        channel: 'Channel to use (required for evidencechannel action)',
      },
    },
    choices: {
      listTypes: {
        all: 'all',
        black: 'black',
        white: 'white',
        watch: 'watch',
        trusted: 'trusted',
      },
      listActions: {
        add: 'add',
        remove: 'remove',
      },
      scopes: {
        all: 'all',
        global: 'global',
        server: 'server',
      },
      multiaddActions: {
        template: 'template - download blank template',
        file: 'file - upload filled template',
      },
      remoteActions: {
        view: 'view - show all servers + bot config',
        off: 'off - toggle notify for a server',
        defaultscope: 'defaultscope - set scope for a server',
        evidencechannel: 'evidencechannel - set image rehost channel (bot-wide)',
        syncimages: 'syncimages - migrate legacy URLs to rehosted evidence',
      },
    },
  },

  help: {
    overview: {
      title: 'Lost Ark Check - Help (EN)',
      footer: 'Switch language: /la-language-switch (persistent) - /la-help lang:vi (one-off)',
      lines: [
        '**Available Commands:**',
        'All bot commands use the `/la-` prefix so Discord groups them under `/la` autocomplete.',
        '',
        '`/la-status` - Show live server status for all monitored servers',
        '`/la-reset` - Reset the stored status state',
        '`/la-language-switch` - Switch LoaLogs language for your account',
        '',
        '`/la-roster name [deep] [deep_limit]` - Fetch roster + progression tracking + list check. `deep:true` runs Stronghold alt scan (officers/seniors only).',
        '`/la-search name [min_ilvl] [max_ilvl] [class]` - Search similar names with filters',
        '`/la-evidence name [public]` - Direct evidence lookup (autocomplete-driven, bypasses list view paging). `public:true` is officer/senior only.',
        '',
        '`/la-list add type name reason [raid] [logs] [image] [scope]` - Add to blacklist/whitelist/watchlist. Scope: global/server (blacklist only).',
        '`/la-list edit name [reason] [type] [raid] [logs] [image] [scope] [additional_names]` - Edit an existing entry. `additional_names` appends alts manually for hidden-roster/no-guild edges.',
        '`/la-list remove name` - Remove an entry from a list',
        '`/la-list view type [scope]` - View entries (type: all/black/white/watch/trusted, scope: all/global/server)',
        '`/la-list trust action name [reason]` - Manage trusted list (add/remove, officer only)',
        '`/la-list enrich name [deep_limit]` - Stronghold deep-scan an existing entry and append discovered alts (officers/seniors only, about 10-15 minutes).',
        '`/la-list multiadd action [file]` - Bulk add via Excel template (see dropdown for details)',
        '',
        '`/la-check image` - Check names from screenshot against all lists',
        '',
        '`/la-setup autochannel #channel` - Set auto-check channel for this server',
        '`/la-setup notifychannel #channel` - Set notification channel for this server',
        '`/la-setup view` - View current channel configuration',
        '`/la-setup off` - Toggle global list notifications on/off',
        '`/la-setup defaultscope global/server` - Set default blacklist scope for /la-list add',
      ],
      ownerLines: [
        '**Owner Server Only:**',
        '`/la-stats` - Show bot usage statistics',
        '`/la-remote action [guild] [scope] [channel]` - Senior: remote config dashboard (view / off / defaultscope / evidencechannel / syncimages)',
        '`/la-remote action:evidencechannel channel:#...` - Set evidence storage channel (bot rehosts here to avoid Discord CDN expiry)',
        '`/la-remote action:syncimages` - Migrate legacy images to rehost storage. See dropdown for the detailed flow.',
      ],
    },
    dropdown: {
      placeholder: 'Pick a section for details...',
      overview: {
        label: 'Command list',
        description: 'Return to the command list',
        emoji: '📋',
      },
      multiadd: {
        label: '/la-list multiadd',
        description: 'Bulk add multiple entries via Excel template',
        emoji: '📦',
      },
      syncimages: {
        label: '/la-remote syncimages',
        description: 'Legacy image migration (owner-only)',
        emoji: '🔄',
      },
    },
    sections: {
      multiadd: {
        title: '/la-list multiadd - Bulk Add via Excel',
        description: 'Add **up to 30 entries** at once to blacklist/whitelist/watchlist via a single Excel file, instead of running `/la-list add` one at a time.',
        footer: 'Multiadd detail - pick the dropdown to switch sections',
        fields: [
          {
            name: 'How to use (4 steps)',
            value: [
              '**1.** `/la-list multiadd action:template` -> Bot sends a blank template file',
              '**2.** Open in Excel, delete the yellow example row, fill in up to 30 rows',
              '**3.** `/la-list multiadd action:file file:<your file>` -> Bot shows a preview',
              '**4.** Click **Confirm** to proceed, or **Cancel** to abort',
            ],
          },
          {
            name: 'Template columns',
            value: [
              '**Required:** `name`, `type`, `reason`',
              '**Optional:** `raid`, `logs`, `image`, `scope`',
              '- `type` (dropdown): `black` / `white` / `watch`',
              '- `scope` (dropdown): `global` / `server` - blacklist only',
              '- `logs` and `image` must be URLs (`https://...`)',
            ],
          },
          {
            name: 'Permission & approval flow',
            value: [
              '**Officer / Senior** -> batch runs immediately after Confirm, with progress updates',
              '**Regular member** -> batch sent to **Senior as ONE DM** (no spam per row)',
              'Senior clicks Approve -> batch runs + requester notified in origin channel',
              'Senior clicks Reject -> requester notified of rejection',
              'Only the original uploader can click Confirm/Cancel',
            ],
          },
          {
            name: 'Limits & rules',
            value: [
              '- Max **30 rows** per file',
              '- File size <= **1 MB**, `.xlsx` only',
              '- Preview expires after **5 minutes**',
              '- Reuses `/la-list add` rules: ilvl >= 1700, trusted users skipped, duplicate check',
              '- Failed rows listed in preview but **do not block** valid rows',
              '- Duplicate names within the same file (case-insensitive) are rejected',
            ],
          },
          {
            name: 'Edge cases',
            value: [
              '- **Name already in list** -> `Skipped` with reason `"duplicate (already in list)"`',
              '- **Name does not exist** (no roster) -> `Skipped` with reason `"No roster found for..."`',
              '- **Trusted user** -> auto-`Skipped` (exact match or alt via roster)',
              '- **ilvl < 1700** -> `Skipped` with reason `"has item level X (below 1700)"`',
              '- **Runtime error** (network/DB) -> `Failed` with error message',
              '- **Important:** one row failing does **not** block other rows; batch runs to completion',
            ],
          },
          {
            name: 'Evidence images',
            value: "Excel does not support embedded images. Upload the screenshot to Discord first, right-click -> Copy Link, then paste the URL into the `image` column.",
          },
        ],
      },
      syncimages: {
        title: '/la-remote action:syncimages - Legacy Image Migration',
        description: 'One-shot migration for **legacy entries** whose evidence is stored as a direct URL (created before the rehost flow). Bot re-downloads each image and re-uploads it to the evidence channel so the URL does not expire again.',
        footer: 'Owner-only - race-safe legacy image migration',
        fields: [
          {
            name: 'Prerequisites',
            value: [
              '**1.** `/la-remote action:evidencechannel channel:#...` already set',
              '**2.** Bot has `Send Messages` + `Attach Files` permission in that channel',
              '**3.** Run from a Senior account (only Senior has `/la-remote` permission)',
            ],
          },
          {
            name: 'Flow per entry (about 1.2-1.5s each)',
            value: [
              '**1.** Detect URL host: Discord CDN vs external (Imgur, etc.)',
              '**2.** Discord URL -> call `attachments/refresh-urls` for a fresh signature',
              '       External URL -> use as-is, no refresh needed',
              '**3.** Download file -> upload to evidence channel with audit metadata',
              '**4.** Compare-and-swap DB update: clear `imageUrl`, set `imageMessageId/imageChannelId`',
            ],
          },
          {
            name: 'Side effects (read before running)',
            value: [
              '- Evidence channel will receive **1 new message per entry** within minutes',
              '- 100 entries -> about 2-3 min runtime + 100 messages flooding the channel',
              '- Recommended: mute channel first, run off-hours for large batches',
              '- Idempotent: safe to re-run, already-migrated entries are skipped automatically',
            ],
          },
          {
            name: 'Result counters',
            value: [
              '**Synced** - entry migrated successfully, has new rehost refs',
              '**Skipped (dead URLs)** - original file deleted, cannot recover',
              '**Skipped (raced)** - entry was edited/migrated by another source',
              '**Failed** - infra error (channel down, rate limit, etc.); retryable',
            ],
          },
          {
            name: 'Troubleshooting',
            value: [
              '- `Failed > 0` -> check Railway logs, can retry later',
              '- `Skipped (dead)` -> entries are unrecoverable; consider remove + re-add',
              '- `Skipped (raced)` -> orphan upload in channel, warn log shows location',
              '- In all cases: **no data loss**; skipped entries are untouched',
            ],
          },
        ],
      },
    },
  },

  listView: {
    labels: {
      allLists: 'All Lists',
      black: 'Blacklist',
      white: 'Whitelist',
      watch: 'Watchlist',
      trusted: 'Trusted Users',
    },
    summary: {
      header: 'Showing **{shown}** of **{total}** {entryLabel} · page **{page}** / {totalPages}',
      entries: 'entries',
      typedEntries: '{label} entries',
      footer: 'Refresh with /la-list view · navigate with the buttons below',
    },
    scope: {
      local: 'Local',
      localWithGuild: 'Local: {guildName}',
    },
    meta: {
      evidence: 'evidence',
      alts: 'alts',
      more: '+{count} more',
    },
    navigation: {
      evidencePlaceholder: 'View evidence for...',
      expired: 'Session expired · re-run /la-list view',
      noReason: 'No reason',
    },
    empty: {
      allTitle: 'All Lists Empty',
      allDescription: 'No entries in any list yet.',
      typedTitle: '{label} Empty',
      typedDescription: 'No entries in the {label} yet.',
    },
    trusted: {
      title: 'Trusted Users',
      footer: '{count} trusted characters · cannot be added to any list',
      emptyTitle: 'Trusted List Empty',
      emptyDescription: 'No trusted users yet.',
      emptyFooter: 'Use /la-list trust action:add to mark a character trusted (officer-only).',
    },
    evidence: {
      reason: '📝 Reason',
      raid: '🗡️ Raid',
      list: '📒 List',
      added: '🕐 Added',
      evidence: 'Evidence',
      unavailable: 'Image link expired or unavailable. Re-add evidence via `/la-list edit`.',
      logs: '🔗 Logs',
      viewLogs: 'View Logs',
      addedBy: '👤 Added by',
      onlyThisCharacter: '_Only this character is tracked on this entry._',
      noImage: 'No evidence image for this entry.',
    },
  },

  quickAdd: {
    selectPlaceholder: '⚡ Quick Add to List · select a name',
    noListHit: 'No DB list hit',
    modalTitle: 'Quick Add · {name}',
    typeLabel: 'Type (black / watch)',
    typePlaceholder: 'black',
    reasonLabel: 'Reason',
    reasonPlaceholder: 'Why add this player?',
    raidLabel: 'Raid (optional)',
    raidPlaceholder: 'e.g. Kazeros Hard',
  },

  remove: {
    removeFrom: '{index}. Remove from {label}',
    removeAll: '{index}. Remove all',
  },

  languageSwitch: {
    title: '🌐 Switch LoaLogs language',
    description: 'Pick the language you want LoaLogs to use. Supported responses will display in that language going forward.',
    currentLine: 'Current: **{flag} {label}**',
    placeholder: '🌐 Pick a language...',
    options: {
      en: 'English (default, cross-server)',
      vi: 'Tiếng Việt (thân thiện hơn)',
      jp: '日本語 (Senko-flavored)',
    },
    successTitle: '🌐 Language updated',
    successDescription: 'LoaLogs will speak **{flag} {label}** with you from now on.',
    unchangedTitle: '🌐 Language unchanged',
    unchangedDescription: "You're already using **{flag} {label}**.",
    footer: 'Run /la-language-switch any time to switch back',
  },
};

export default en;
