const vi = {
  language: {
    code: 'vi',
    label: 'Tiếng Việt',
    nativeShort: 'Tiếng Việt',
    flag: '🇻🇳',
  },

  common: {
    pagination: {
      previous: 'Trước',
      next: 'Tiếp',
    },
    actions: {
      approve: 'Duyệt',
      reject: 'Từ chối',
      approving: 'Đang duyệt...',
      rejecting: 'Đang từ chối...',
      approved: 'Đã duyệt',
      rejected: 'Đã từ chối',
      processed: 'Đã xử lý',
      failed: 'Thất bại',
      blocked: 'Bị chặn',
      cancel: 'Huỷ',
      discard: 'Bỏ qua',
      overwrite: 'Ghi đè',
      keepExisting: 'Giữ entry cũ',
      keptExisting: 'Đã giữ entry cũ',
      overwritten: 'Đã ghi đè',
      viewEvidenceFresh: '📎 Xem evidence (fresh)',
      viewEvidence: 'Xem evidence',
      openEvidence: 'Mở evidence',
      approveAdd: 'Duyệt · thêm {count}',
      confirmAdd: 'Xác nhận thêm {count}',
      confirmAddCompact: 'Xác nhận · thêm {count}',
      savePartial: 'Lưu tạm · {count}',
      continueScan: 'Quét tiếp',
      stopScan: 'Dừng quét',
      stopping: 'Đang dừng...',
      jumpToResult: 'Mở kết quả',
      enrichNow: 'Enrich ngay',
    },
  },

  commands: {
    help: {
      options: {
        lang: 'Ngôn ngữ (mặc định: preference đã lưu)',
      },
    },
    languageSwitch: {
      description: 'Đổi ngôn ngữ LoaLogs dùng cho phản hồi của cậu',
    },
  },

  autoCheckWelcome: {
    title: '🎨 Artist chỉ đi ngang qua thôi~',
    description: [
      'Artist tình cờ đi ngang channel này rồi để lại một tấm bảng nhỏ. LoaLogs mới là người ở lại trông screenshot cho các cậu nhé.',
      'Cứ thả screenshot có tên character vào đây; bot sẽ đọc ảnh rồi đối chiếu từng tên với các list của server.',
    ],
    howName: '🔍 Sau khi cậu gửi ảnh',
    howValue: [
      '1. LoaLogs thả reaction 🔍 và đọc tối đa 8 tên character.',
      '2. Các tên được kiểm tra với blacklist, whitelist, watchlist và trusted.',
      '3. Tên chưa nằm trong list có thể hiện Quick Add cho officer xử lý ngay.',
    ],
    listsName: '📚 Đọc kết quả thế nào',
    listsValue: [
      'Kết quả black và watch cần chú ý; white và trusted cung cấp ngữ cảnh đối chiếu.',
      'Muốn kiểm tra thủ công không cần ảnh thì dùng /la-search name:<character>.',
    ],
    cleanupName: '🧹 Channel được dọn mỗi ngày',
    cleanupValue: [
      'Đúng **00:00 Asia/Ho_Chi_Minh (17:00 UTC)**, LoaLogs sẽ xóa toàn bộ tin nhắn không ghim trong channel này.',
      'Tin đã ghim được giữ lại. Nội dung quan trọng thì cậu chuyển sang nơi khác trước giờ dọn nhé.',
    ],
    commandsName: '🧭 Các lệnh hữu ích',
    commandsValue: [
      '/la-check image:<screenshot> - kiểm tra ảnh thủ công',
      '/la-roster name:<character> - xem roster',
      '/la-search name:<character> - tìm và đối chiếu list',
      '/la-help - mở hướng dẫn đầy đủ',
    ],
    footer: 'Artist đi tiếp đây~ Tấm bảng này cứ để lại nhé.',
  },

  help: {
    overview: {
      title: 'Lost Ark Check - Help (VI)',
      footer: 'Đổi ngôn ngữ: /la-language-switch (cố định) - /la-help lang:en (xem 1 lần)',
      intro: 'Tất cả lệnh bot dùng prefix `/la-` để Discord gom vào nhóm `/la` autocomplete.',
      groups: [
        {
          name: '📡 Theo dõi server',
          lines: [
            '`/la-status` - Xem trạng thái server Lost Ark đang monitor',
            '`/la-reset` - Reset trạng thái đã lưu',
          ],
        },
        {
          name: '🔍 Roster & Tìm kiếm',
          lines: [
            '`/la-roster name [deep] [deep_limit]` - Tra roster + progression + list check. `deep:true` chạy Stronghold alt scan (chỉ officer/senior).',
            '`/la-search name [min_ilvl] [max_ilvl] [class]` - Tìm tên tương tự với filter',
            '`/la-evidence name [public]` - Xem evidence trực tiếp bằng autocomplete, không cần vào list view. `public:true` chỉ officer/senior.',
          ],
        },
        {
          name: '📒 Lists',
          lines: [
            '`/la-list add type name reason [raid] [logs] [image] [scope]` - Thêm vào blacklist/whitelist/watchlist. Scope global/server chỉ áp dụng blacklist.',
            '`/la-list edit name [reason] [type] [raid] [logs] [image] [scope] [additional_names]` - Sửa entry đã có. `additional_names` dùng để append alt thủ công cho case hidden roster/no-guild.',
            '`/la-list remove name` - Xoá entry khỏi list',
            '`/la-list view type [scope]` - Xem list (type: all/black/white/watch/trusted, scope: all/global/server)',
          ],
        },
        {
          name: '📦 Lists · Trust & Bulk',
          lines: [
            '`/la-list trust action name [reason]` - Quản lý trusted list (add/remove, chỉ officer)',
            '`/la-list enrich name [deep_limit]` - Stronghold deep-scan entry đã có và append alt tìm được (chỉ officer/senior, khoảng 10-15 phút).',
            '`/la-list multiadd action [file]` - Bulk add qua Excel template (xem dropdown để biết chi tiết)',
          ],
        },
        {
          name: '🖼️ Check ảnh chụp',
          lines: [
            '`/la-check image` - Trích tên từ ảnh chụp rồi check với tất cả list',
          ],
        },
        {
          name: '⚙️ Cài đặt server',
          lines: [
            '`/la-setup autochannel #channel` - Set channel auto-check ảnh cho server này',
            '`/la-setup notifychannel #channel` - Set channel nhận thông báo list',
            '`/la-setup view` - Xem config hiện tại',
            '`/la-setup repin` - Làm mới bảng hướng dẫn Artist đã ghim',
            '`/la-setup language` - Đổi ngôn ngữ public và tin ghim của server',
            '`/la-setup off` - Bật/tắt global list notifications',
            '`/la-setup defaultscope global/server` - Set default blacklist scope cho /la-list add',
          ],
        },
        {
          name: '🌐 Cá nhân',
          lines: [
            '`/la-language-switch` - Đổi ngôn ngữ LoaLogs cho account của cậu',
          ],
        },
      ],
      ownerGroup: {
        name: '👑 Chỉ Owner Server',
        lines: [
          '`/la-stats` - Xem thống kê bot',
          '`/la-remote action [guild] [scope] [channel]` - Senior: remote config dashboard (view / off / defaultscope / evidencechannel / syncimages)',
          '`/la-remote action:evidencechannel channel:#...` - Set channel lưu evidence (bot rehost ảnh ở đây để tránh Discord CDN expire)',
          '`/la-remote action:syncimages` - Migrate ảnh legacy sang rehost storage. Xem chi tiết trong dropdown.',
        ],
      },
    },
    dropdown: {
      placeholder: 'Chọn section để xem chi tiết...',
      overview: {
        label: 'Danh sách lệnh',
        description: 'Quay lại overview lệnh',
      },
      multiadd: {
        description: 'Bulk add nhiều entry qua Excel template',
      },
      syncimages: {
        description: 'Migrate ảnh legacy (owner-only)',
      },
    },
    sections: {
      multiadd: {
        title: '/la-list multiadd - Bulk Add qua Excel',
        description: 'Thêm **tối đa 30 entries** cùng lúc vào blacklist/whitelist/watchlist bằng một file Excel, thay vì chạy `/la-list add` từng dòng.',
        footer: 'Chi tiết multiadd - dùng dropdown để chuyển section',
        fields: [
          {
            name: 'Cách dùng (4 bước)',
            value: [
              '**1.** `/la-list multiadd action:template` -> Bot gửi file template trắng',
              '**2.** Mở bằng Excel, xoá dòng ví dụ màu vàng, điền tối đa 30 dòng',
              '**3.** `/la-list multiadd action:file file:<file của cậu>` -> Bot hiện preview',
              '**4.** Bấm **Confirm** để chạy, hoặc **Cancel** để huỷ',
            ],
          },
          {
            name: 'Các cột trong template',
            value: [
              '**Bắt buộc:** `name`, `type`, `reason`',
              '**Tuỳ chọn:** `raid`, `logs`, `image`, `scope`',
              '- `type` (dropdown): `black` / `white` / `watch`',
              '- `scope` (dropdown): `global` / `server` - chỉ blacklist',
              '- `logs` và `image` phải là URL (`https://...`)',
            ],
          },
          {
            name: 'Quyền & flow duyệt',
            value: [
              '**Officer / Senior** -> batch chạy ngay sau Confirm, có progress update',
              '**Member thường** -> batch gửi cho **Senior bằng một DM** (không spam từng row)',
              'Senior bấm Approve -> batch chạy + requester được báo trong channel gốc',
              'Senior bấm Reject -> requester được báo bị reject',
              'Chỉ người upload ban đầu mới bấm được Confirm/Cancel',
            ],
          },
          {
            name: 'Giới hạn & luật',
            value: [
              '- Tối đa **30 rows** mỗi file',
              '- File size <= **1 MB**, chỉ `.xlsx`',
              '- Preview hết hạn sau **5 phút**',
              '- Tái sử dụng luật `/la-list add`: ilvl >= 1700, trusted bị skip, duplicate check',
              '- Row lỗi vẫn hiện ở preview nhưng **không block** row hợp lệ',
              '- Tên duplicate trong cùng file (case-insensitive) sẽ bị reject',
            ],
          },
          {
            name: 'Case đặc biệt',
            value: [
              '- **Tên đã có trong list** -> `Skipped` với reason `"duplicate (already in list)"`',
              '- **Tên không tồn tại** (no roster) -> `Skipped` với reason `"No roster found for..."`',
              '- **Trusted user** -> tự `Skipped` (exact match hoặc alt qua roster)',
              '- **ilvl < 1700** -> `Skipped` với reason `"has item level X (below 1700)"`',
              '- **Runtime error** (network/DB) -> `Failed` kèm error message',
              '- **Quan trọng:** lỗi một row **không** block row khác; batch chạy tới hết',
            ],
          },
          {
            name: 'Ảnh evidence',
            value: 'Excel không hỗ trợ embedded image. Upload screenshot lên Discord trước, right-click -> Copy Link, rồi paste URL vào cột `image`.',
          },
        ],
      },
      syncimages: {
        title: '/la-remote action:syncimages - Migrate ảnh legacy',
        description: 'One-shot migration cho **entry cũ** đang lưu evidence bằng URL trực tiếp. Bot tải lại từng ảnh và re-upload vào evidence channel để URL không expire nữa.',
        footer: 'Owner-only - migrate ảnh legacy theo kiểu race-safe',
        fields: [
          {
            name: 'Prerequisites',
            value: [
              '**1.** Đã set `/la-remote action:evidencechannel channel:#...`',
              '**2.** Bot có quyền `Send Messages` + `Attach Files` trong channel đó',
              '**3.** Chạy bằng account Senior (chỉ Senior có quyền `/la-remote`)',
            ],
          },
          {
            name: 'Flow mỗi entry (khoảng 1.2-1.5s)',
            value: [
              '**1.** Detect host URL: Discord CDN hay external (Imgur, v.v.)',
              '**2.** Discord URL -> gọi `attachments/refresh-urls` lấy chữ ký mới',
              '       External URL -> dùng nguyên URL, không cần refresh',
              '**3.** Download file -> upload vào evidence channel với audit metadata',
              '**4.** Compare-and-swap update DB: clear `imageUrl`, set `imageMessageId/imageChannelId`',
            ],
          },
          {
            name: 'Side effect (đọc trước khi chạy)',
            value: [
              '- Evidence channel sẽ nhận **1 message mới mỗi entry** trong vài phút',
              '- 100 entries -> khoảng 2-3 phút runtime + 100 messages trong channel',
              '- Nên mute channel trước, chạy off-hours nếu batch lớn',
              '- Idempotent: chạy lại an toàn, entry đã migrate sẽ tự skip',
            ],
          },
          {
            name: 'Result counters',
            value: [
              '**Synced** - migrate thành công, có rehost refs mới',
              '**Skipped (dead URLs)** - file gốc bị xoá, không recover được',
              '**Skipped (raced)** - entry vừa bị edit/migrate bởi nguồn khác',
              '**Failed** - lỗi infra (channel down, rate limit, v.v.); retry được',
            ],
          },
          {
            name: 'Troubleshooting',
            value: [
              '- `Failed > 0` -> check Railway logs, có thể retry sau',
              '- `Skipped (dead)` -> entry không recover được; cân nhắc remove + add lại',
              '- `Skipped (raced)` -> có orphan upload trong channel, warn log sẽ chỉ location',
              '- Mọi case đều **không mất data**; entry skipped không bị touch',
            ],
          },
        ],
      },
    },
  },

  listView: {
    labels: {
      allLists: 'Tất cả list',
      black: 'Blacklist',
      white: 'Whitelist',
      watch: 'Watchlist',
      trusted: 'Trusted users',
    },
    summary: {
      header: 'Trang **{page}** / {totalPages} · đang hiện **{shown}**',
      entries: 'entry',
      footer: 'Refresh bằng /la-list view · dùng nút bên dưới để chuyển trang',
    },
    scope: {
      local: 'Local',
      localWithGuild: 'Local: {guildName}',
    },
    meta: {
      evidence: 'evidence',
      alts: 'alts',
      more: '+{count} nữa',
    },
    navigation: {
      evidencePlaceholder: 'Xem evidence của...',
      expired: 'Hết hạn · chạy lại /la-list view',
      noReason: 'Chưa có lý do',
    },
    empty: {
      allTitle: 'Tất cả list đang trống',
      allDescription: 'Chưa có entry nào trong các list.',
      typedTitle: 'List {label} đang trống',
      typedDescription: 'Chưa có entry nào trong {label}.',
    },
    trusted: {
      title: 'Trusted users',
      footer: 'Không thể thêm vào bất kỳ list nào · quản lý bằng /la-list trust action:add',
      emptyTitle: 'Trusted list đang trống',
      emptyDescription: 'Chưa có trusted user nào.',
      emptyFooter: 'Dùng /la-list trust action:add để đánh dấu character trusted (chỉ officer).',
    },
    evidence: {
      reason: '📝 Lý do',
      raid: '🗡️ Raid',
      list: '📒 List',
      added: '🕐 Đã thêm',
      evidence: 'Evidence',
      unavailable: 'Link ảnh đã hết hạn hoặc không khả dụng. Re-add evidence bằng `/la-list edit`.',
      logs: '🔗 Logs',
      viewLogs: 'Xem logs',
      addedBy: '👤 Người thêm',
      onlyThisCharacter: '_Chỉ character này đang được track trong entry._',
      noImage: 'Entry này chưa có ảnh evidence.',
    },
  },

  quickAdd: {
    selectPlaceholder: '⚡ Quick Add vào list · chọn tên',
    noListHit: 'Chưa có hit trong DB',
    modalTitle: 'Quick Add · {name}',
    typeLabel: 'Loại (black / watch)',
    typePlaceholder: 'black',
    reasonLabel: 'Lý do',
    reasonPlaceholder: 'Vì sao thêm player này?',
    raidLabel: 'Raid (tuỳ chọn)',
    raidPlaceholder: 'vd. Kazeros Hard',
  },

  remove: {
    removeFrom: '{index}. Xoá khỏi {label}',
    removeAll: '{index}. Xoá tất cả',
  },

  languageSwitch: {
    title: '🌐 Đổi ngôn ngữ LoaLogs',
    description: 'Chọn ngôn ngữ cậu muốn LoaLogs dùng. Những phần đã hỗ trợ locale sẽ hiển thị bằng ngôn ngữ này từ giờ.',
    currentLine: 'Hiện tại: **{flag} {label}**',
    placeholder: '🌐 Chọn ngôn ngữ...',
    options: {
      en: 'English (mặc định, cross-server)',
      vi: 'Tiếng Việt (thân thiện hơn)',
      jp: '日本語 (giọng Senko)',
    },
    successTitle: '🌐 Đã đổi ngôn ngữ',
    successDescription: 'Từ giờ LoaLogs sẽ nói với cậu bằng **{flag} {label}**.',
    unchangedTitle: '🌐 Ngôn ngữ không đổi',
    unchangedDescription: 'Cậu vẫn đang dùng **{flag} {label}** mà.',
    footer: '/la-language-switch để đổi lại bất cứ lúc nào',
  },
};

export default vi;
