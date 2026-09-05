# Verification

Chạy tại root checkout LoaLogs, với Node.js đáp ứng `package.json` (hiện >=20.19.0)
và dependency đã có. Lệnh chuẩn:

```powershell
git status --short --branch
npm test
git diff --check
```

`npm test` chỉ khám phá `test/`, tránh chạy nhầm script trong scratch/worktree cục bộ.
LoaLogs có test MongoDB tạm qua `mongodb-memory-server`; lần đầu có thể tải binary.
Không thay test này bằng database thật.

| Thay đổi | Test liên quan |
| --- | --- |
| Cache/metadata | `node --test test/lru-ttl-cache.test.js test/meta-cache.test.js test/roster-url.test.js` |
| OCR/model chain | `node --test test/gemini-model-config.test.js test/ocr-profiles.test.js test/ocr-preferences.test.js test/ocr-inflight.test.js test/listcheck-ocr-cache.test.js test/auto-check-dedupe.test.js` |
| List approval/scope | `node --test test/scope-query.test.js test/pending-approval-access.test.js test/list-mutation-flow.test.js test/list-overwrite-approval.test.js test/approval-locale-boundary.test.js` |
| Worker/monitor | `node --test test/scrape-worker.test.js test/worker-heartbeat.test.js test/monitor.test.js` |

Khi di chuyển file, kiểm tra `node --check <file>` và tìm mọi import cũ bằng `rg`.
Từ workspace cha có thể dùng `.agent/verify.ps1 -Repo LoaLogs -Full` để kiểm tra
syntax toàn bộ JavaScript và chạy đúng `npm test`.

`npm run benchmark:ocr -- --image <path> ...` giữ đường dẫn input tương đối với
working directory của caller; implementation ở `scripts/ocr-benchmark.js`. Đây là
benchmark gọi Gemini, không phải smoke test offline.

Sau publish, so `git rev-parse HEAD` với remote branch thực tế bằng `git ls-remote`.
Test/syntax chứng minh hành vi local; remote ref chứng minh publication. Railway
deployment và Discord interaction cần bằng chứng riêng, không suy ra từ test pass.
