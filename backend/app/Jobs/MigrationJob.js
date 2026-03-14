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

  isAborted() { return this.progress.isAborted(this.jobId); }

  async run() {
    const { src_url, src_user, src_pass, dst_url, dst_user, dst_pass } = this.data;
    const zipPath = path.join(this.storage, this.jobId + '_backup.zip');

    try {
      // 1. Login source
      this.step('login', 5, `Đăng nhập source: ${src_url}`);
      if (this.isAborted()) return this._aborted();
      const srcSession = await this.wp.login(src_url, src_user, src_pass);

      // 2. Login destination
      this.step('login', 10, `Đăng nhập destination: ${dst_url}`);
      if (this.isAborted()) return this._aborted();
      const dstSession = await this.wp.login(dst_url, dst_user, dst_pass);

      // 3. Install plugin on source (auto via browser if not present)
      this.step('plugin', 18, 'Cài helper plugin trên source...');
      if (this.isAborted()) return this._aborted();
      await this.wp.installMigratorPlugin(srcSession);

      // 4. Install plugin on destination
      this.step('plugin', 28, 'Cài helper plugin trên destination...');
      if (this.isAborted()) return this._aborted();
      await this.wp.installMigratorPlugin(dstSession);

      // 5. Create backup on source
      this.step('backup', 40, 'Tạo backup (database + files + plugins + themes)...');
      if (this.isAborted()) return this._aborted();
      const backupInfo = await this.wp.createBackup(srcSession, this.jobId);

      // 6. Download backup
      this.step('download', 58, `Tải backup về (${Math.round((backupInfo.size||0)/1024/1024)}MB)...`);
      if (this.isAborted()) return this._aborted();
      await this.wp.downloadBackup(srcSession, backupInfo, zipPath);

      // 7. Restore on destination
      this.step('restore', 75, 'Upload và restore trên destination...');
      if (this.isAborted()) return this._aborted();
      const srcClean = src_url.trim().replace(/\/+$/, '');
      const dstClean = dst_url.trim().replace(/\/+$/, '');
      await this.wp.uploadAndRestore(dstSession, zipPath, srcClean, dstClean);

      // 8. Cleanup local zip
      try { fs.unlinkSync(zipPath); } catch {}

      // Done
      this.progress.update(this.jobId, { step: 'done', percent: 100, message: '✓ Migration hoàn tất!', status: 'done' });
      this.log('[DONE] Migration completed successfully.');

    } catch(err) {
      this.progress.update(this.jobId, { step: 'error', percent: 0, message: 'Lỗi: ' + err.message, status: 'error' });
      this.log('[ERROR] ' + err.message);
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
    }
  }

  _aborted() {
    this.log('[ABORT] Job aborted by user.');
    this.progress.update(this.jobId, { step: 'error', percent: 0, message: 'Đã hủy', status: 'aborted' });
  }
}

module.exports = MigrationJob;
