# WP Migrator Pro v2.0

Nhân bản toàn bộ WordPress sang hosting mới — chỉ cần URL + tài khoản admin.  
**Không cần SSH. Không cần biết DB. Không cần biết server.**

---

## Quick Start

```bash
npm install
node server.js
# hoặc đổi port:
PORT=3001 node server.js
```

Mở **http://localhost:3000/migrate**

---

## Cách dùng

Chỉ cần điền 6 ô:

| Source | Destination |
|---|---|
| URL website nguồn | URL website đích |
| WP Admin username | WP Admin username |
| WP Admin password | WP Admin password |

Nhấn **Sync / Migrate!** — tool tự làm hết:

1. 🔑 Login vào cả 2 WP Admin
2. 🔧 Tự cài helper plugin (tạm thời)
3. 💾 Tạo backup toàn bộ (DB + wp-content + themes + plugins)
4. 📥 Download backup về server trung gian
5. 📦 Upload & restore sang site đích
6. 🌐 Tự động thay thế domain trong database
7. ✅ Xóa helper plugin — site đích sạch hoàn toàn

---

## Cấu trúc

```
wp-migrator-pro/
├── server.js                          ← Node.js HTTP server (port 3000)
├── package.json
├── backend/
│   ├── app/
│   │   ├── Services/
│   │   │   ├── WpAdminService.js      ← Toàn bộ logic WP automation
│   │   │   └── ProgressService.js     ← Theo dõi tiến độ per-job
│   │   └── Jobs/
│   │       └── MigrationJob.js        ← Orchestrator: login→backup→restore
│   └── routes/                        ← (reserved)
├── frontend/
│   ├── dashboard/index.html           ← Danh sách jobs + stats
│   ├── migrate-form/index.html        ← Form migrate (Imapsync-style)
│   └── progress-view/index.html       ← Live progress + logs
└── storage/logs/                      ← Per-job progress JSON + log files
```

---

## API

| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/migrate/start` | Bắt đầu migration |
| GET  | `/api/migrate/progress/:jobId` | Lấy tiến độ |
| POST | `/api/migrate/abort/:jobId` | Hủy job |
| GET  | `/api/migrate/logs/:jobId` | Lấy logs |
| GET  | `/api/jobs` | Danh sách tất cả jobs |

### Start payload
```json
{
  "src_url":  "https://site-nguon.com",
  "src_user": "admin",
  "src_pass": "password",
  "dst_url":  "https://site-moi.com",
  "dst_user": "admin",
  "dst_pass": "password"
}
```

---

## Yêu cầu

- **Node.js ≥ 18**
- Site nguồn & đích phải có **WordPress đang chạy** và tài khoản **Administrator**
- Site đích phải cho phép upload plugin (cần quyền `manage_options`)
- PHP `ZipArchive` extension phải được bật trên cả 2 hosting (thường có sẵn)

---

## Dependencies

```
node-fetch   ^3.3.2   — HTTP requests
form-data    ^4.0.0   — multipart upload
```

---

## License

MIT
