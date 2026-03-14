'use strict';

const fs             = require('fs');
const path           = require('path');
const WpAdminService = require('../Services/WpAdminService');

class MigrationJob {
  constructor(jobId, data, progressService, storageDir) {
    this.jobId    = jobId;
    this.data     = data;
    this.progress = progressService;
    this.storage  = storageDir;
    this.logFile  = path.join(storageDir, jobId + '.log');
    this.wp       = new WpAdminService(progressService, jobId, this.logFile);
  }

  log(msg) {
    const line = `[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${msg}`;
    fs.appendFileSync(this.logFile, line + '\n');
  }

  step(step, percent, message) {
    this.progress.update(this.jobId, { step, percent, message, status: 'running' });
    this.log(`[${step.toUpperCase()}] ${message}`);
  }

  async run() {
    const { src_url, src_user, src_pass, dst_url, dst_user, dst_pass } = this.data;
    const zipPath = path.join(this.storage, this.jobId + '_backup.zip');

    try {
      // ── 1. Login to source ──────────────────────────────────────────────
      this.step('login', 5, `Đang đăng nhập source: ${src_url}`);
      if (this.progress.isAborted(this.jobId)) return this._aborted();
      const srcSession = await this.wp.login(src_url, src_user, src_pass);

      // ── 2. Login to destination ─────────────────────────────────────────
      this.step('login', 10, `Đang đăng nhập destination: ${dst_url}`);
      if (this.progress.isAborted(this.jobId)) return this._aborted();
      const dstSession = await this.wp.login(dst_url, dst_user, dst_pass);

      // ── 3. Check plugin on source ───────────────────────────────────────
      this.step('plugin', 18, 'Kiểm tra helper plugin trên source...');
      if (this.progress.isAborted(this.jobId)) return this._aborted();
      await this.wp.checkPlugin(srcSession);

      // ── 4. Check plugin on destination ──────────────────────────────────
      this.step('plugin', 22, 'Kiểm tra helper plugin trên destination...');
      if (this.progress.isAborted(this.jobId)) return this._aborted();
      await this.wp.checkPlugin(dstSession);

      // ── 5. Create backup on source ──────────────────────────────────────
      this.step('backup', 35, 'Đang tạo backup (database + files + plugins + themes)...');
      if (this.progress.isAborted(this.jobId)) return this._aborted();
      const backupInfo = await this.wp.createBackup(srcSession, this.jobId);

      // ── 6. Download backup to this server ───────────────────────────────
      this.step('download', 55, `Đang tải backup về (${Math.round((backupInfo.size||0)/1024/1024)}MB)...`);
      if (this.progress.isAborted(this.jobId)) return this._aborted();
      await this.wp.downloadBackup(srcSession, backupInfo, zipPath);

      // ── 7. Upload & restore on destination ──────────────────────────────
      this.step('restore', 75, 'Đang upload và restore trên destination...');
      if (this.progress.isAborted(this.jobId)) return this._aborted();
      const srcClean = src_url.trim().replace(/\/+$/, '');
      const dstClean = dst_url.trim().replace(/\/+$/, '');
      await this.wp.uploadAndRestore(dstSession, zipPath, srcClean, dstClean);

      // ── 8. Cleanup local zip ────────────────────────────────────────────
      try { fs.unlinkSync(zipPath); } catch {}

      // ── Done ────────────────────────────────────────────────────────────
      this.progress.update(this.jobId, {
        step: 'done', percent: 100,
        message: '✓ Migration hoàn tất!',
        status: 'done',
      });
      this.log('[DONE] Migration completed successfully.');

    } catch (err) {
      this.progress.update(this.jobId, {
        step: 'error', percent: 0,
        message: 'Lỗi: ' + err.message,
        status: 'error',
      });
      this.log('[ERROR] ' + err.message);
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
    }
  }

  _aborted() {
    this.log('[ABORT] Job was aborted by user.');
  }
}

module.exports = MigrationJob;
