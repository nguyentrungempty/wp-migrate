'use strict';

const fs   = require('fs');
const path = require('path');

class ProgressService {
  constructor(storageDir) {
    this.dir = storageDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  init(jobId) {
    this._write(jobId, {
      job_id:  jobId,
      status:  'running',
      step:    'init',
      percent: 0,
      message: 'Initializing migration...',
      aborted: false,
      started: this._ts(),
      updated: this._ts(),
    });
  }

  update(jobId, data) {
    const cur = this.get(jobId);
    if (cur.aborted) return;
    this._write(jobId, { ...cur, ...data, job_id: jobId, updated: this._ts() });
  }

  get(jobId) {
    const f = this._file(jobId);
    if (!fs.existsSync(f)) return { job_id: jobId, status: 'not_found', percent: 0 };
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
  }

  abort(jobId) {
    const cur = this.get(jobId);
    this._write(jobId, { ...cur, status: 'aborted', aborted: true, message: 'Aborted by user.', updated: this._ts() });
  }

  isAborted(jobId) { return !!this.get(jobId).aborted; }

  list() {
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('_progress.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.started || '').localeCompare(a.started || ''));
  }

  _write(jobId, data) {
    fs.writeFileSync(this._file(jobId), JSON.stringify(data, null, 2));
  }

  _file(jobId) { return path.join(this.dir, jobId + '_progress.json'); }
  _ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
}

module.exports = ProgressService;
