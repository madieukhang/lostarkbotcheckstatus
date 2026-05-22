const jp = {
  language: {
    code: 'jp',
    label: '日本語',
    nativeShort: '日本語',
    flag: '🇯🇵',
  },

  common: {
    pagination: {
      previous: '前へ',
      next: '次へ',
    },
  },

  commands: {
    help: {
      options: {
        lang: '言語 (既定: 保存した設定)',
      },
    },
    languageSwitch: {
      description: 'LoaLogs があなたへ返す言語を切り替えます',
    },
  },

  help: {
    overview: {
      title: 'Lost Ark Check - Help (JP)',
      footer: '言語変更: /la-language-switch (保存) - /la-help lang:en (一度だけ)',
      lines: [
        '**コマンド一覧:**',
        'すべての bot コマンドは `/la-` prefix を使うので、Discord の autocomplete では `/la` の下にまとまります。',
        '',
        '`/la-status` - 監視中の Lost Ark サーバー状態を見る',
        '`/la-reset` - 保存済みステータスをリセット',
        '`/la-language-switch` - あなたの LoaLogs 表示言語を切り替え',
        '',
        '`/la-roster name [deep] [deep_limit]` - roster + progression + list check。`deep:true` は Stronghold alt scan (officer/senior のみ)。',
        '`/la-search name [min_ilvl] [max_ilvl] [class]` - filter 付きで似た名前を検索',
        '`/la-evidence name [public]` - list view を通さず evidence を直接表示。`public:true` は officer/senior のみ。',
        '',
        '`/la-list add type name reason [raid] [logs] [image] [scope]` - blacklist/whitelist/watchlist に追加。scope global/server は blacklist のみ。',
        '`/la-list edit name [reason] [type] [raid] [logs] [image] [scope] [additional_names]` - 既存 entry を編集。`additional_names` は hidden roster/no-guild 用の手動 alt 追加。',
        '`/la-list remove name` - list から entry を削除',
        '`/la-list view type [scope]` - list 表示 (type: all/black/white/watch/trusted, scope: all/global/server)',
        '`/la-list trust action name [reason]` - trusted list 管理 (add/remove, officer のみ)',
        '`/la-list enrich name [deep_limit]` - 既存 entry を Stronghold deep-scan し、見つかった alt を追加 (officer/senior のみ、約10-15分)。',
        '`/la-list multiadd action [file]` - Excel template で bulk add (詳細は dropdown)',
        '',
        '`/la-check image` - スクリーンショットから名前を抽出し、すべての list と照合',
        '',
        '`/la-setup autochannel #channel` - この server の auto-check channel を設定',
        '`/la-setup notifychannel #channel` - list notification channel を設定',
        '`/la-setup view` - 現在の config を表示',
        '`/la-setup off` - global list notifications の on/off',
        '`/la-setup defaultscope global/server` - /la-list add の default blacklist scope を設定',
      ],
      ownerLines: [
        '**Owner Server のみ:**',
        '`/la-stats` - bot 統計を見る',
        '`/la-remote action [guild] [scope] [channel]` - Senior: remote config dashboard (view / off / defaultscope / evidencechannel / syncimages)',
        '`/la-remote action:evidencechannel channel:#...` - evidence 保存 channel を設定 (Discord CDN expiry 回避のため bot が rehost)',
        '`/la-remote action:syncimages` - legacy image を rehost storage へ migrate。詳細は dropdown へ。',
      ],
    },
    dropdown: {
      placeholder: '詳細を見たい section を選んでね...',
      overview: {
        label: 'コマンド一覧',
        description: 'コマンド overview に戻る',
      },
      multiadd: {
        description: 'Excel template で複数 entry を bulk add',
      },
      syncimages: {
        description: 'Legacy image migration (owner-only)',
      },
    },
    sections: {
      multiadd: {
        title: '/la-list multiadd - Excel Bulk Add',
        description: '一つの Excel file で blacklist/whitelist/watchlist に **最大30 entries** をまとめて追加できます。`/la-list add` を一件ずつ打つ必要はありませんわ。',
        footer: 'Multiadd 詳細 - dropdown で section を切り替え',
        fields: [
          {
            name: '使い方 (4 steps)',
            value: [
              '**1.** `/la-list multiadd action:template` -> bot が空 template を送信',
              '**2.** Excel で開き、黄色い例 row を削除し、最大30 row を入力',
              '**3.** `/la-list multiadd action:file file:<your file>` -> bot が preview を表示',
              '**4.** **Confirm** で実行、または **Cancel** で中止',
            ],
          },
          {
            name: 'Template columns',
            value: [
              '**Required:** `name`, `type`, `reason`',
              '**Optional:** `raid`, `logs`, `image`, `scope`',
              '- `type` (dropdown): `black` / `white` / `watch`',
              '- `scope` (dropdown): `global` / `server` - blacklist のみ',
              '- `logs` と `image` は URL (`https://...`) が必要',
            ],
          },
          {
            name: 'Permission & approval flow',
            value: [
              '**Officer / Senior** -> Confirm 後すぐ batch 実行、progress update あり',
              '**Regular member** -> batch は **Senior に 1 DM** で送信 (row ごとの spam なし)',
              'Senior が Approve -> batch 実行 + requester に元 channel で通知',
              'Senior が Reject -> requester に reject 通知',
              'Confirm/Cancel を押せるのは最初に upload した人だけ',
            ],
          },
          {
            name: 'Limits & rules',
            value: [
              '- 1 file 最大 **30 rows**',
              '- File size <= **1 MB**、`.xlsx` のみ',
              '- Preview は **5分** で expire',
              '- `/la-list add` rules を再利用: ilvl >= 1700, trusted skip, duplicate check',
              '- Failed rows は preview に出るが、valid rows は **block しない**',
              '- 同一 file 内の duplicate names (case-insensitive) は reject',
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
            value: 'Excel は embedded image を扱いません。先に screenshot を Discord に upload し、right-click -> Copy Link して `image` column に貼ってくださいませ。',
          },
        ],
      },
      syncimages: {
        title: '/la-remote action:syncimages - Legacy Image Migration',
        description: '直接 URL として保存されている **legacy entries** の evidence を一括 migration します。Bot が各 image を再 download し、evidence channel に re-upload するので URL が expire しません。',
        footer: 'Owner-only - race-safe legacy image migration',
        fields: [
          {
            name: 'Prerequisites',
            value: [
              '**1.** `/la-remote action:evidencechannel channel:#...` が設定済み',
              '**2.** Bot にその channel の `Send Messages` + `Attach Files` 権限がある',
              '**3.** Senior account で実行 (Senior のみ `/la-remote` 可)',
            ],
          },
          {
            name: 'Flow per entry (about 1.2-1.5s each)',
            value: [
              '**1.** URL host を判定: Discord CDN vs external (Imgur, etc.)',
              '**2.** Discord URL -> `attachments/refresh-urls` で fresh signature を取得',
              '       External URL -> そのまま使用、refresh 不要',
              '**3.** Download file -> evidence channel へ audit metadata 付きで upload',
              '**4.** Compare-and-swap DB update: clear `imageUrl`, set `imageMessageId/imageChannelId`',
            ],
          },
          {
            name: 'Side effects (read before running)',
            value: [
              '- Evidence channel に **1 entry につき 1 message** が数分内に投稿されます',
              '- 100 entries -> 約2-3分 runtime + 100 messages',
              '- Large batch は channel mute + off-hours 実行がおすすめ',
              '- Idempotent: 再実行 safe、migration 済み entry は自動 skip',
            ],
          },
          {
            name: 'Result counters',
            value: [
              '**Synced** - migration 成功、新しい rehost refs あり',
              '**Skipped (dead URLs)** - original file deleted, cannot recover',
              '**Skipped (raced)** - entry が別 source により edit/migrate 済み',
              '**Failed** - infra error (channel down, rate limit, etc.); retryable',
            ],
          },
          {
            name: 'Troubleshooting',
            value: [
              '- `Failed > 0` -> Railway logs を確認、後で retry 可能',
              '- `Skipped (dead)` -> recover 不可; remove + add again を検討',
              '- `Skipped (raced)` -> orphan upload in channel, warn log に location あり',
              '- どの case でも **data loss なし**; skipped entries は untouched',
            ],
          },
        ],
      },
    },
  },

  listView: {
    labels: {
      allLists: 'すべての list',
      black: 'Blacklist',
      white: 'Whitelist',
      watch: 'Watchlist',
      trusted: 'Trusted users',
    },
    summary: {
      header: '**{shown}** / **{total}** {entryLabel} を表示中 · page **{page}** / {totalPages}',
      entries: 'entries',
      typedEntries: '{label} entries',
      footer: '/la-list view で更新 · 下のボタンで page 移動',
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
      evidencePlaceholder: 'evidence を見る...',
      expired: '期限切れ · /la-list view を再実行',
      noReason: 'No reason',
    },
    empty: {
      allTitle: 'すべての list は空です',
      allDescription: 'まだどの list にも entry がありません。',
      typedTitle: '{label} は空です',
      typedDescription: '{label} にはまだ entry がありません。',
    },
    trusted: {
      title: 'Trusted users',
      footer: '{count} trusted characters · どの list にも追加できません',
      emptyTitle: 'Trusted list は空です',
      emptyDescription: 'trusted user はまだいません。',
      emptyFooter: '/la-list trust action:add で character を trusted にできます (officer only)。',
    },
    evidence: {
      reason: '📝 Reason',
      raid: '🗡️ Raid',
      list: '📒 List',
      added: '🕐 Added',
      evidence: 'Evidence',
      unavailable: '画像 link が期限切れ、または利用できません。`/la-list edit` で evidence を追加し直してください。',
      logs: '🔗 Logs',
      viewLogs: 'View Logs',
      addedBy: '👤 Added by',
      onlyThisCharacter: '_この entry ではこの character だけが track されています._',
      noImage: 'この entry には evidence 画像がありません。',
    },
  },

  languageSwitch: {
    title: '🌐 LoaLogs の言語を変更',
    description: 'LoaLogs に使ってほしい言語を選んでくださいませ。Locale 対応済みの response はこれからその言語で表示されますわ。',
    currentLine: '現在: **{flag} {label}**',
    placeholder: '🌐 言語を選んでください...',
    options: {
      en: 'English (default, cross-server)',
      vi: 'Tiếng Việt (やわらかめ)',
      jp: '日本語 (Senko 風)',
    },
    successTitle: '🌐 言語を変更しました',
    successDescription: 'これから LoaLogs は **{flag} {label}** でお話しますわ。',
    unchangedTitle: '🌐 言語は変わっていません',
    unchangedDescription: 'もう **{flag} {label}** を使っていますわ。',
    footer: 'いつでも /la-language-switch で変更できます',
  },
};

export default jp;
