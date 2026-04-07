'use strict';

const http            = require('http');
const fs              = require('fs');
const path            = require('path');
const crypto          = require('crypto');
const ProgressService = require('./backend/app/Services/ProgressService');
const MigrationJob    = require('./backend/app/Jobs/MigrationJob');
const WpAdminService  = require('./backend/app/Services/WpAdminService');

const PORT     = process.env.PORT || 3001;
const STORAGE  = path.join(__dirname, 'storage', 'logs');
const FRONTEND = path.join(__dirname, 'frontend');
const AUTH_FILE = path.join(__dirname, 'storage', 'users.json');

if (!fs.existsSync(STORAGE)) fs.mkdirSync(STORAGE, { recursive: true });

const progress = new ProgressService(STORAGE);

// ── Auth system ───────────────────────────────────────────────────────────────
// Sessions: token → { username, created }
const sessions = {};

function loadUsers() {
  if (!fs.existsSync(AUTH_FILE)) {
    // Default admin user — password: admin123 (change after first login)
    const defaultUsers = {
      admin: hashPassword('admin123'),
    };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(defaultUsers, null, 2));
    console.log('\n  ⚠️  Default credentials: admin / admin123');
    console.log('  Change password via: POST /api/auth/change-password\n');
    return defaultUsers;
  }
  return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'wpm_salt_2026').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getTokenFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/wpm_token=([a-f0-9]{64})/);
  if (match) return match[1];
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function getSession(req) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const session = sessions[token];
  if (!session) return null;
  // Session expires after 24 hours
  if (Date.now() - session.created > 24 * 60 * 60 * 1000) {
    delete sessions[token];
    return null;
  }
  return session;
}

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

// Check if job belongs to user
function jobBelongsTo(jobId, username) {
  const p = progress.get(jobId);
  if (!p) return false;
  // Jobs created before auth system had no owner — allow admin to see them
  // Also allow if owner matches
  if (!p.owner || p.owner === 'unknown') return true;
  return p.owner === username;
}

// ── Server ────────────────────────────────────────────────────────────────────

const users = loadUsers();

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',  origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // ── Login page (public) ────────────────────────────────────────────────────
  if (url === '/login') {
    return serveFile(res, path.join(FRONTEND, 'login', 'index.html'));
  }

  // ── Auth API (public) ──────────────────────────────────────────────────────
  if (url === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const { username, password } = body;
    const users = loadUsers();
    if (!username || !password || users[username] !== hashPassword(password)) {
      return json(res, 401, { success: false, error: 'Sai tài khoản hoặc mật khẩu' });
    }
    const token = generateToken();
    sessions[token] = { username, created: Date.now() };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `wpm_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    });
    return res.end(JSON.stringify({ success: true, username }));
  }

  if (url === '/api/auth/logout' && method === 'POST') {
    const token = getTokenFromRequest(req);
    if (token) delete sessions[token];
    res.writeHead(200, { 'Set-Cookie': 'wpm_token=; Path=/; Max-Age=0' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (url === '/api/auth/me' && method === 'GET') {
    const session = getSession(req);
    if (!session) return json(res, 401, { success: false });
    return json(res, 200, { success: true, username: session.username });
  }

  if (url === '/api/auth/change-password' && method === 'POST') {
    const session = getSession(req);
    if (!session) return json(res, 401, { success: false, error: 'Not logged in' });
    const body = await readBody(req);
    if (!body.new_password || body.new_password.length < 6) {
      return json(res, 400, { success: false, error: 'Mật khẩu phải ít nhất 6 ký tự' });
    }
    const users = loadUsers();
    users[session.username] = hashPassword(body.new_password);
    fs.writeFileSync(AUTH_FILE, JSON.stringify(users, null, 2));
    return json(res, 200, { success: true, message: 'Đã đổi mật khẩu' });
  }

  // ── All routes below require authentication ────────────────────────────────
  const session = getSession(req);
  if (!session) {
    // API calls → 401
    if (url.startsWith('/api/')) return json(res, 401, { success: false, error: 'Chưa đăng nhập' });
    // Page requests → redirect to login
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  const { username } = session;

  // ── Jobs list (only own jobs) ──────────────────────────────────────────────
  if (url === '/api/jobs' && method === 'GET') {
    const allJobs = progress.list();
    const myJobs  = allJobs.filter(j => j.owner === username);
    return json(res, 200, myJobs);
  }

  // ── Start migration ────────────────────────────────────────────────────────
  if (url === '/api/migrate/start' && method === 'POST') {
    const body    = await readBody(req);
    const missing = ['src_url','src_user','src_pass','dst_url','dst_user','dst_pass'].filter(k => !body[k]);
    if (missing.length) return json(res, 400, { success: false, error: 'Missing: ' + missing.join(', ') });

    const jobId = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    progress.init(jobId, username);
    new MigrationJob(jobId, body, progress, STORAGE).run().catch(console.error);
    return json(res, 200, { success: true, job_id: jobId });
  }

  // ── Progress (own jobs only) ───────────────────────────────────────────────
  const progMatch = url.match(/^\/api\/migrate\/progress\/(.+)$/);
  if (progMatch && method === 'GET') {
    if (!jobBelongsTo(progMatch[1], username)) return json(res, 403, { success: false, error: 'Access denied' });
    return json(res, 200, progress.get(progMatch[1]));
  }

  // ── Abort (own jobs only) ──────────────────────────────────────────────────
  const abortMatch = url.match(/^\/api\/migrate\/abort\/(.+)$/);
  if (abortMatch && method === 'POST') {
    if (!jobBelongsTo(abortMatch[1], username)) return json(res, 403, { success: false, error: 'Access denied' });
    progress.abort(abortMatch[1]);
    return json(res, 200, { success: true });
  }

  // ── Logs (own jobs only) ───────────────────────────────────────────────────
  const logsMatch = url.match(/^\/api\/migrate\/logs\/(.+)$/);
  if (logsMatch && method === 'GET') {
    if (!jobBelongsTo(logsMatch[1], username)) return json(res, 403, { success: false, error: 'Access denied' });
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

  // ── Check plugin ───────────────────────────────────────────────────────────
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
  console.log(`  ║   WP Migrator Pro  v3.1  — ready     ║`);
  console.log(`  ║   http://localhost:${PORT}               ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  console.log(`  Dashboard  →  http://localhost:${PORT}/dashboard`);
  console.log(`  Migrate    →  http://localhost:${PORT}/migrate\n`);
});
