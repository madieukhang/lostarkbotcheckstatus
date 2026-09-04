# Repository map

| Khu vực | Trách nhiệm |
| --- | --- |
| `bot.js`, `loa-worker.js` | Entry bot/worker; không đổi vị trí tùy tiện |
| `bot/app/`, `bot/commands/` | Lifecycle, registration, interaction router, slash schema |
| `bot/handlers/` | Discord commands/components theo feature |
| `bot/handlers/list/services/` | List mutation/approval/broadcast cần closure của handler |
| `bot/services/list-check/` | OCR, matching, verification và enrichment |
| `bot/services/roster/` | Bible fetch/parse, character metadata, guild/roster scan |
| `bot/services/setup/` | Channel lifecycle, cleanup và permissions |
| `bot/services/worker/` | Scrape jobs và heartbeat |
| `bot/monitor/` | Thaemine status và persisted transition claims |
| `bot/utils/cache/` | LRU/TTL primitive và character metadata cache |
| `bot/utils/` | Names, scope, embeds, sessions và async helpers dùng chung |
| `bot/models/`, `bot/locales/` | Mongo schemas và i18n |
| `scripts/ocr-benchmark.js` | Benchmark phát triển, gọi Gemini và có chi phí/quota |
| `test/`, `assets/` | Node test suite và icon runtime |

## Contract cần giữ

- `bot/utils/names.js` là nơi chuẩn hóa tên; tránh tạo quy tắc riêng cho slash,
  auto-check hay list edit. Các tên Unicode tương đương phải giữ cùng semantics.
- `rememberNormalizedName` giữ cách viết đầu tiên và thứ tự tên trong một Map.
  `createApprovalMessageUpdater` ở list services cập nhật tin nhắn đang bấm trước
  khi đồng bộ các DM còn lại; builder nhận ngôn ngữ của từng người nhận.
- Mọi nút tiêu thụ pending approval, gồm giữ/ghi đè, phải kiểm tra `approverIds`
  qua `resolvePendingApprovalAccess` trước khi xóa yêu cầu.
- Đọc `bot/config/geminiModels.js` và test tương ứng để biết model chain hiện tại;
  không sao chép một danh sách version vào tài liệu rồi coi đó là nguồn chuẩn.
- OCR retry/cache phải giữ phân biệt lỗi transient với kết quả hợp lệ, đồng thời
  giữ dữ liệu của những ảnh đã xử lý thành công trong batch nhiều ảnh.
- Cache chỉ giữ kết quả mà caller cho phép. Thay đổi giới hạn động có hiệu lực ở
  lần ghi tiếp theo; cập nhật cùng key không tự chiếm thêm một slot.
- `bot/utils/scope.js` cùng list services giữ ranh giới guild/global và approval.
- Monitor giữ Thaemine-only và cơ chế chống thông báo trùng qua persisted state.
- Embed headline và detail là các renderer riêng; thay đổi vị trí field phải
  đúng renderer, giữ fallback và giới hạn Discord.
- Không hợp nhất module chỉ vì tên giống RaidManage: hai runtime dùng module
  system khác nhau và triển khai riêng.
