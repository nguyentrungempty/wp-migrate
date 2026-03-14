'use strict';

const http            = require('http');
const fs              = require('fs');
const path            = require('path');
const ProgressService = require('./backend/app/Services/ProgressService');
const MigrationJob    = require('./backend/app/Jobs/MigrationJob');

const PORT     = process.env.PORT || 3000;
const STORAGE  = path.join(__dirname, 'storage', 'logs');
const FRONTEND = path.join(__dirname, 'frontend');

const progress = new ProgressService(STORAGE);

// ── helpers ──────────────────────────────────────────────────────────────────

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

function serveHtml(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

function getLogs(jobId) {
  const f = path.join(STORAGE, jobId + '.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
}

// ── server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // ── API ──

  // List all jobs
  if (url === '/api/jobs' && method === 'GET') {
    return json(res, 200, progress.list());
  }

  // Start migration
  if (url === '/api/migrate/start' && method === 'POST') {
    const body = await readBody(req);
    const required = ['src_url', 'src_user', 'src_pass', 'dst_url', 'dst_user', 'dst_pass'];
    const missing  = required.filter(k => !body[k]);
    if (missing.length) {
      return json(res, 400, { success: false, error: 'Missing fields: ' + missing.join(', ') });
    }

    const jobId = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    progress.init(jobId);

    // Run async (non-blocking)
    const job = new MigrationJob(jobId, body, progress, STORAGE);
    job.run().catch(console.error);

    return json(res, 200, { success: true, job_id: jobId });
  }

  // Get progress
  const progMatch = url.match(/^\/api\/migrate\/progress\/(.+)$/);
  if (progMatch && method === 'GET') {
    return json(res, 200, progress.get(progMatch[1]));
  }

  // Abort
  const abortMatch = url.match(/^\/api\/migrate\/abort\/(.+)$/);
  if (abortMatch && method === 'POST') {
    progress.abort(abortMatch[1]);
    return json(res, 200, { success: true });
  }

  // Logs
  const logsMatch = url.match(/^\/api\/migrate\/logs\/(.+)$/);
  if (logsMatch && method === 'GET') {
    return json(res, 200, { success: true, logs: getLogs(logsMatch[1]) });
  }

  // Download wpm-helper.zip
  if (url === '/api/plugin/download' && method === 'GET') {
    const pluginPath = path.join(__dirname, 'backend', 'app', 'Services', 'plugin-template.php');
    const WpAdmin    = require('./backend/app/Services/WpAdminService');
    const svc        = new WpAdmin(null, 'download', '/dev/null');
    const zipBuf     = svc._buildPluginZip();
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="wpm-helper.zip"',
      'Content-Length': zipBuf.length,
    });
    return res.end(zipBuf);
  }

  // Check if plugin is active on a site
  if (url === '/api/plugin/check' && method === 'POST') {
    const body = await readBody(req);
    const { site_url, username, password } = body;
    if (!site_url) return json(res, 400, { success: false, error: 'Missing site_url' });
    try {
      const https = require('https');
      const http2 = require('http');
      const { URL } = require('url');
      const u = new URL(site_url.replace(/\/$/, '') + '/wp-admin/admin-ajax.php');
      const lib = u.protocol === 'https:' ? https : http2;
      const postData = 'action=wpm_get_nonce';
      const result = await new Promise((resolve) => {
        const req2 = lib.request({
          hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': postData.length },
          rejectUnauthorized: false, timeout: 10000,
        }, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => resolve({ status: r.statusCode, body: d }));
        });
        req2.on('error', () => resolve({ status: 0, body: '' }));
        req2.on('timeout', () => { req2.destroy(); resolve({ status: 0, body: 'timeout' }); });
        req2.write(postData); req2.end();
      });
      const active = result.status === 200 && result.body.includes('"success":true');
      return json(res, 200, { success: true, active, status: result.status, body: result.body.slice(0, 100) });
    } catch(e) {
      return json(res, 200, { success: false, active: false, error: e.message });
    }
  }

  // ── Frontend pages ──

  if (url === '/' || url === '/dashboard') {
    return serveHtml(res, path.join(FRONTEND, 'dashboard', 'index.html'));
  }
  if (url === '/migrate') {
    return serveHtml(res, path.join(FRONTEND, 'migrate-form', 'index.html'));
  }
  if (url === '/progress') {
    return serveHtml(res, path.join(FRONTEND, 'progress-view', 'index.html'));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   WP Migrator Pro  v2.0  — ready         ║`);
  console.log(`  ║   http://localhost:${PORT}                  ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
  console.log(`  Dashboard  →  http://localhost:${PORT}/dashboard`);
  console.log(`  Migrate    →  http://localhost:${PORT}/migrate\n`);
});
