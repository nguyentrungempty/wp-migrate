'use strict';

const http            = require('http');
const fs              = require('fs');
const path            = require('path');
const ProgressService = require('./backend/app/Services/ProgressService');
const MigrationJob    = require('./backend/app/Jobs/MigrationJob');
const WpAdminService  = require('./backend/app/Services/WpAdminService');

const PORT     = process.env.PORT || 3000;
const STORAGE  = path.join(__dirname, 'storage', 'logs');
const FRONTEND = path.join(__dirname, 'frontend');

if (!fs.existsSync(STORAGE)) fs.mkdirSync(STORAGE, { recursive: true });

const progress = new ProgressService(STORAGE);

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end',  () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    res.end(data);
  });
}

function getLogs(jobId) {
  const f = path.join(STORAGE, jobId + '.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // ── Jobs list ──────────────────────────────────────────────────────────────
  if (url === '/api/jobs' && method === 'GET') {
    return json(res, 200, progress.list());
  }

  // ── Start migration ────────────────────────────────────────────────────────
  if (url === '/api/migrate/start' && method === 'POST') {
    const body    = await readBody(req);
    const missing = ['src_url','src_user','src_pass','dst_url','dst_user','dst_pass'].filter(k => !body[k]);
    if (missing.length) return json(res, 400, { success: false, error: 'Missing: ' + missing.join(', ') });

    const jobId = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    progress.init(jobId);
    new MigrationJob(jobId, body, progress, STORAGE).run().catch(console.error);
    return json(res, 200, { success: true, job_id: jobId });
  }

  // ── Progress ───────────────────────────────────────────────────────────────
  const progMatch = url.match(/^\/api\/migrate\/progress\/(.+)$/);
  if (progMatch && method === 'GET') {
    return json(res, 200, progress.get(progMatch[1]));
  }

  // ── Abort ──────────────────────────────────────────────────────────────────
  const abortMatch = url.match(/^\/api\/migrate\/abort\/(.+)$/);
  if (abortMatch && method === 'POST') {
    progress.abort(abortMatch[1]);
    return json(res, 200, { success: true });
  }

  // ── Logs ───────────────────────────────────────────────────────────────────
  const logsMatch = url.match(/^\/api\/migrate\/logs\/(.+)$/);
  if (logsMatch && method === 'GET') {
    return json(res, 200, { success: true, logs: getLogs(logsMatch[1]) });
  }

  // ── Download wpm-helper.zip ────────────────────────────────────────────────
  if (url === '/api/plugin/download' && method === 'GET') {
    try {
      const svc    = new WpAdminService(null, 'download', '/dev/null');
      const zipBuf = svc._buildPluginZip();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="wpm-helper.zip"',
        'Content-Length': zipBuf.length,
      });
      return res.end(zipBuf);
    } catch(e) {
      return json(res, 500, { success: false, error: e.message });
    }
  }

  // ── Check plugin active on a site ──────────────────────────────────────────
  if (url === '/api/plugin/check' && method === 'POST') {
    const body = await readBody(req);
    if (!body.site_url) return json(res, 400, { success: false, error: 'Missing site_url' });
    try {
      const svc    = new WpAdminService(null, 'check', '/dev/null');
      const active = await svc._isPluginActive({ siteUrl: body.site_url.replace(/\/+$/, ''), cookies: {} });
      return json(res, 200, { success: true, active });
    } catch(e) {
      return json(res, 200, { success: false, active: false, error: e.message });
    }
  }

  // ── Frontend ───────────────────────────────────────────────────────────────
  if (url === '/' || url === '/dashboard') return serveFile(res, path.join(FRONTEND, 'dashboard', 'index.html'));
  if (url === '/migrate')                  return serveFile(res, path.join(FRONTEND, 'migrate-form', 'index.html'));
  if (url === '/progress')                 return serveFile(res, path.join(FRONTEND, 'progress-view', 'index.html'));

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   WP Migrator Pro  v3.0  — ready     ║`);
  console.log(`  ║   http://localhost:${PORT}               ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  console.log(`  Dashboard  →  http://localhost:${PORT}/dashboard`);
  console.log(`  Migrate    →  http://localhost:${PORT}/migrate\n`);
});
