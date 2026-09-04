# LoaLogs maintenance guide

LoaLogs là Discord bot ES modules cho Thaemine monitor, roster/Bible, quản lý list
và OCR. `bot.js` chạy bot; `loa-worker.js` chạy Bible scrape worker riêng.

- [Repository map](repository-map.md): nơi đặt code và các contract cần giữ.
- [Verification](verification.md): lệnh kiểm tra và giới hạn của từng bằng chứng.
- [Product README](../README.md) và [repo instructions](../AGENTS.md).

## Quy trình ngắn

1. Kiểm tra branch/dirty state và đọc phần module liên quan.
2. Nếu phát hiện lỗi hành vi, tái hiện bằng test nhỏ trước khi sửa.
3. Đổi vị trí file cùng mọi import/caller/test, giữ entrypoint và đường dẫn dữ liệu.
4. Chạy test liên quan, toàn bộ suite và whitespace/syntax phù hợp.
5. Kiểm tra diff, rồi thực hiện commit/push trong phạm vi đã được ủy quyền và xác
   nhận remote ref. Báo riêng những gì chưa được kiểm tra ở runtime.

Thư mục `.agent/` được version control và bị loại khỏi Docker image. Chỉ
`.agent/local/` chứa ghi chú/log không version control. Giữ nguyên `docs/`, `.claude/`,
`data/` và `exports/` cục bộ; không gom chúng vào commit cấu trúc repo.
