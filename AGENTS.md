# LoaLogs repository instructions

- Đọc [.agent/README.md](.agent/README.md) và bản đồ module trước khi sửa.
- Đây là checkout độc lập, dùng JavaScript **ES modules** (`type: module`). Các
  relative import phải có phần mở rộng `.js`; không import source của RaidManage.
- Giữ `bot.js` và `loa-worker.js` tại root: đây là entrypoint triển khai.
- Xem `git status --short --branch` trước khi sửa; giữ nguyên thay đổi ngoài phạm vi.
- Handler thuộc `bot/handlers/<feature>/`, I/O thuộc `bot/services/<domain>/`, helper
  dùng chung thuộc `bot/utils/`. Cache dùng chung nằm trong `bot/utils/cache/`.
- Công cụ phát triển thuộc `scripts/`; hướng dẫn thuộc `.agent/`; ghi chú/log tạm
  thuộc `.agent/local/` (Git ignore). Không chuyển dữ liệu runtime vào source.
- Giữ nguyên chuẩn hóa tên, thứ tự Gemini fallback, ranh giới guild/global và luồng
  approval; chi tiết nằm trong [.agent/repository-map.md](.agent/repository-map.md).
- Comments và console logs bằng English; chuỗi hiển thị qua i18n vi/en/jp. Comment
  giải thích invariant hoặc lý do; exported API mới/sửa cần JSDoc hữu ích.
- Theo [.agent/verification.md](.agent/verification.md): test liên quan trước,
  toàn bộ `npm test` trước khi chốt; cập nhật import, test và README khi đổi vị trí file.
- Đọc `.env.example` để biết tên biến, không in `.env` hay credentials. Không chạy
  bot, OCR benchmark hoặc script tác động Discord như một bước kiểm tra local.
- Commit/push thông thường sau khi hoàn tất và kiểm tra tuân theo phạm vi và thỏa
  thuận hiện có với người dùng. Force-push, reset, xóa dữ liệu và mở rộng triển khai
  cần ủy quyền riêng. Git publication không chứng minh Railway/Discord đang khỏe.
