'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const os    = require('os');
const { URL } = require('url');

const PLUGIN_PHP_PATH = path.join(__dirname, 'plugin-template.php');

class WpAdminService {

  constructor(progressService, jobId, logFile) {
    this.progress = progressService;
    this.jobId    = jobId;
    this.logFile  = logFile || '/dev/null';
  }

  log(msg) {
    const line = '[' + new Date().toISOString().replace('T',' ').slice(0,19) + '] ' + msg;
    try { fs.appendFileSync(this.logFile, line + '\n'); } catch {}
    console.log(line);
  }

  // ── HTTP engine ───────────────────────────────────────────────────────────

  _request(urlStr, options, body, _redirectCount) {
    options        = options || {};
    _redirectCount = _redirectCount || 0;
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(urlStr); } catch(e) { return reject(new Error('Bad URL: ' + urlStr)); }
      const isHttps = u.protocol === 'https:';
      const lib     = isHttps ? https : http;
      const headers = Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      }, options.headers || {});
      const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
      if (bodyBuf) headers['Content-Length'] = String(bodyBuf.length);
      const req = lib.request({
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''), method: options.method || 'GET',
        headers, timeout: options.timeout || 120000,
        rejectUnauthorized: false, checkServerIdentity: () => undefined,
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && _redirectCount < 8) {
          const loc  = res.headers.location;
          const next = loc.startsWith('http') ? loc : new URL(loc, urlStr).href;
          const newOpts = Object.assign({}, options);
          if ([301,302,303].includes(res.statusCode) && (options.method||'GET') === 'POST') {
            newOpts.method = 'GET';
            if (newOpts.headers) { delete newOpts.headers['Content-Type']; delete newOpts.headers['Content-Length']; }
            body = null;
          }
          res.resume();
          return this._request(next, newOpts, body, _redirectCount + 1).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf,
            text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
        });
      });
      req.on('error', err => reject(new Error('HTTP: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + urlStr.slice(0,80))); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  _cookieHeader(c) { return Object.keys(c).map(k => k + '=' + c[k]).join('; '); }

  _parseCookies(headers) {
    const out = {};
    const raw = headers['set-cookie'] || [];
    (Array.isArray(raw) ? raw : [raw]).forEach(c => {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) out[m[1].trim()] = m[2].trim();
    });
    return out;
  }

  _normalizeUrl(url) {
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url.replace(/\/wp-(admin|login\.php)(\/.*)?$/i, '').replace(/\/+$/, '');
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(siteUrl, username, password) {
    siteUrl = this._normalizeUrl(siteUrl);
    this.log('Logging in to ' + siteUrl + ' as ' + username + '...');
    const loginUrl = siteUrl + '/wp-login.php';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const pageRes     = await this._request(loginUrl);
      const initCookies = this._parseCookies(pageRes.headers);
      const postBody    = 'log=' + encodeURIComponent(username) +
        '&pwd=' + encodeURIComponent(password) +
        '&wp-submit=Log+In&redirect_to=' + encodeURIComponent(siteUrl + '/wp-admin/') +
        '&testcookie=1&rememberme=forever';

      const loginRes    = await this._request(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this._cookieHeader(Object.assign({}, initCookies, { wordpress_test_cookie: 'WP+Cookie+check' })),
          'Origin': siteUrl, 'Referer': loginUrl,
        },
      }, postBody);

      const authCookies = Object.assign({}, initCookies, this._parseCookies(loginRes.headers));
      const hasAuth     = Object.keys(authCookies).some(k => k.startsWith('wordpress_logged_in'));
      this.log('[attempt ' + attempt + '] status=' + loginRes.status + ' auth=' + hasAuth);

      if (hasAuth || (loginRes.headers.location || '').includes('wp-admin')) {
        this.log('✓ Login successful: ' + siteUrl);
        return { siteUrl, cookies: authCookies, username, password };
      }
    }
    throw new Error('Login failed for ' + siteUrl + ' — sai tài khoản/mật khẩu');
  }

  // ── Install plugin via Puppeteer headless browser ─────────────────────────

  async installMigratorPlugin(session) {
    this.log('Checking wpm-helper on ' + session.siteUrl + '...');

    if (await this._isPluginActive(session)) {
      this.log('✓ Plugin already active on ' + session.siteUrl);
      return;
    }

    this.log('Plugin not found — installing via headless browser...');
    const zipBuf  = this._buildPluginZip();
    const zipPath = path.join(os.tmpdir(), 'wpm-helper-' + Date.now() + '.zip');
    fs.writeFileSync(zipPath, zipBuf);

    try {
      await this._installViaHeadlessBrowser(session, zipPath);
    } finally {
      try { fs.unlinkSync(zipPath); } catch {}
    }

    await new Promise(r => setTimeout(r, 2000));
    if (!await this._isPluginActive(session)) {
      throw new Error('Plugin uploaded but not responding on ' + session.siteUrl + ' — kiểm tra WP Admin > Plugins');
    }
    this.log('✓ wpm-helper installed and active on ' + session.siteUrl);
  }

  async _isPluginActive(session) {
    try {
      const res  = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': this._cookieHeader(session.cookies) },
        timeout: 15000,
      }, 'action=wpm_get_nonce');
      const body = res.text().trim();
      this.log('Plugin check: ' + body.slice(0, 60));
      return res.status === 200 && body.includes('"success":true');
    } catch { return false; }
  }

  async _installViaHeadlessBrowser(session, zipPath) {
    let puppeteer;
    try { puppeteer = require('puppeteer'); }
    catch { throw new Error('Puppeteer chưa cài. Chạy: cd /home/migrate/wp-migrate && npm install'); }

    this.log('Launching headless Chrome...');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    try {
      // ── 1. Login ──────────────────────────────────────────────────────────
      this.log('Browser: logging in to ' + session.siteUrl);
      await page.goto(session.siteUrl + '/wp-login.php', { waitUntil: 'networkidle2' });
      await page.type('#user_login', session.username, { delay: 20 });
      await page.type('#user_pass',  session.password,  { delay: 20 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#wp-submit'),
      ]);

      if (page.url().includes('wp-login')) {
        const err = await page.$eval('#login_error', el => el.textContent).catch(() => 'unknown');
        throw new Error('Browser login failed: ' + err.trim().slice(0, 100));
      }
      this.log('Browser: logged in, URL=' + page.url());

      // ── 2. Navigate to plugin upload ──────────────────────────────────────
      await page.goto(session.siteUrl + '/wp-admin/plugin-install.php?tab=upload', { waitUntil: 'networkidle2' });
      if (page.url().includes('wp-login')) throw new Error('Redirected to login on plugin-install page');
      this.log('Browser: on plugin-install page');

      // ── 3. Upload zip ─────────────────────────────────────────────────────
      const fileInput = await page.$('input[name="pluginzip"]');
      if (!fileInput) throw new Error('File input not found on plugin-install page');
      await fileInput.uploadFile(zipPath);
      this.log('Browser: file selected, clicking Install Now...');

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
        page.click('#install-plugin-submit'),
      ]);
      this.log('Browser: install result page = ' + page.url());

      const html = await page.content();
      if (html.includes('Installation failed') || html.includes('already installed')) {
        if (html.includes('already installed')) {
          this.log('Plugin already installed, activating...');
        } else {
          throw new Error('Install failed: ' + html.match(/class="wp-die-message">([\s\S]{0,200})/)?.[1]?.replace(/<[^>]+>/g,'').trim() || 'unknown');
        }
      }

      // ── 4. Activate ───────────────────────────────────────────────────────
      // Try activate link on install result page first
      const activateBtn = await page.$('a[href*="action=activate"]');
      if (activateBtn) {
        this.log('Browser: clicking activate on result page...');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2' }),
          activateBtn.click(),
        ]);
      } else {
        // Go to plugins list
        await page.goto(session.siteUrl + '/wp-admin/plugins.php', { waitUntil: 'networkidle2' });
        const activateInList = await page.$('tr[data-slug="wpm-helper"] a[href*="action=activate"]');
        if (activateInList) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            activateInList.click(),
          ]);
          this.log('Browser: activated from plugins list');
        } else {
          const isActive = await page.$('tr.active[data-slug="wpm-helper"]');
          if (!isActive) throw new Error('Cannot activate wpm-helper — check WP Admin > Plugins');
          this.log('Browser: plugin already active in list');
        }
      }

      this.log('Browser: installation complete');
    } finally {
      await browser.close();
    }
  }

  // ── Backup ────────────────────────────────────────────────────────────────

  async createBackup(session, jobId) {
    this.log('Creating backup on ' + session.siteUrl + '...');
    const res = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': this._cookieHeader(session.cookies), 'Referer': session.siteUrl + '/wp-admin/' },
      timeout: 600000,
    }, 'action=wpm_create_backup&job_id=' + encodeURIComponent(jobId));

    const raw = res.text();
    this.log('Backup response: ' + raw.slice(0, 200));
    if (!raw || raw === '0' || raw === '-1') throw new Error('Backup AJAX failed: ' + (raw||'empty'));
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('Backup not JSON: ' + raw.slice(0,200)); }
    if (!data.success) throw new Error('Backup error: ' + (data.data || JSON.stringify(data)));
    this.log('✓ Backup: ' + data.data.file + ' (' + Math.round((data.data.size||0)/1024/1024) + 'MB)');
    return data.data;
  }

  // ── Download ──────────────────────────────────────────────────────────────

  async downloadBackup(session, backupInfo, destPath) {
    this.log('Downloading backup...');
    const res = await this._request(backupInfo.url, { headers: { Cookie: this._cookieHeader(session.cookies) }, timeout: 600000 });
    if (res.status !== 200) throw new Error('Download failed HTTP ' + res.status);
    fs.writeFileSync(destPath, res.body);
    this.log('✓ Downloaded: ' + Math.round(res.body.length/1024/1024) + 'MB');
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  async uploadAndRestore(session, zipPath, oldDomain, newDomain) {
    this.log('Restoring to ' + session.siteUrl + '...');
    let nonce = 'no-nonce';
    try {
      const nr = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': this._cookieHeader(session.cookies) },
        timeout: 15000,
      }, 'action=wpm_get_nonce');
      const nd = JSON.parse(nr.text());
      if (nd.success) nonce = nd.data;
    } catch {}

    const zipData  = fs.readFileSync(zipPath);
    const boundary = 'WPMRestore' + Date.now();
    const parts = [
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="action"\r\n\r\nwpm_restore_backup\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="nonce"\r\n\r\n' + nonce + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="old_domain"\r\n\r\n' + oldDomain + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="new_domain"\r\n\r\n' + newDomain + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="backup"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n'),
      zipData,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ];

    const res = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Cookie': this._cookieHeader(session.cookies), 'Referer': session.siteUrl + '/wp-admin/' },
      timeout: 600000,
    }, Buffer.concat(parts));

    const raw = res.text();
    this.log('Restore response: ' + raw.slice(0, 200));
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('Restore not JSON: ' + raw.slice(0,200)); }
    if (!data.success) throw new Error('Restore error: ' + (data.data || JSON.stringify(data)));
    this.log('✓ Restore completed on ' + session.siteUrl);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  async cleanupPlugin(session) {
    // Keep plugin installed for future migrations — only clean backup files
    try {
      await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': this._cookieHeader(session.cookies) },
        timeout: 15000,
      }, 'action=wpm_cleanup_files');
    } catch {}
    this.log('Cleanup done (plugin kept for future use) on ' + session.siteUrl);
  }

  // ── ZIP builder ───────────────────────────────────────────────────────────

  _buildPluginZip() {
    const phpCode = fs.readFileSync(PLUGIN_PHP_PATH, 'utf8');
    return this._makeZip('wpm-helper/wpm-helper.php', phpCode);
  }

  _makeZip(filename, content) {
    const fileData = Buffer.from(content, 'utf8');
    const fileName = Buffer.from(filename, 'utf8');
    const now      = new Date();
    const dosDate  = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
    const dosTime  = (now.getHours()<<11)|(now.getMinutes()<<5)|Math.floor(now.getSeconds()/2);
    const crc      = this._crc32(fileData);
    const lfh = Buffer.alloc(30 + fileName.length);
    lfh.writeUInt32LE(0x04034b50,0); lfh.writeUInt16LE(20,4); lfh.writeUInt16LE(0,6);
    lfh.writeUInt16LE(0,8); lfh.writeUInt16LE(dosTime,10); lfh.writeUInt16LE(dosDate,12);
    lfh.writeUInt32LE(crc>>>0,14); lfh.writeUInt32LE(fileData.length,18); lfh.writeUInt32LE(fileData.length,22);
    lfh.writeUInt16LE(fileName.length,26); lfh.writeUInt16LE(0,28); fileName.copy(lfh,30);
    const cdh = Buffer.alloc(46 + fileName.length);
    cdh.writeUInt32LE(0x02014b50,0); cdh.writeUInt16LE(20,4); cdh.writeUInt16LE(20,6);
    cdh.writeUInt16LE(0,8); cdh.writeUInt16LE(0,10); cdh.writeUInt16LE(dosTime,12); cdh.writeUInt16LE(dosDate,14);
    cdh.writeUInt32LE(crc>>>0,16); cdh.writeUInt32LE(fileData.length,20); cdh.writeUInt32LE(fileData.length,24);
    cdh.writeUInt16LE(fileName.length,28); cdh.writeUInt16LE(0,30); cdh.writeUInt16LE(0,32);
    cdh.writeUInt16LE(0,34); cdh.writeUInt16LE(0,36); cdh.writeUInt32LE(0,38); cdh.writeUInt32LE(0,42);
    fileName.copy(cdh,46);
    const cdOffset = lfh.length + fileData.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
    eocd.writeUInt16LE(1,8); eocd.writeUInt16LE(1,10); eocd.writeUInt32LE(cdh.length,12);
    eocd.writeUInt32LE(cdOffset,16); eocd.writeUInt16LE(0,20);
    return Buffer.concat([lfh, fileData, cdh, eocd]);
  }

  _crc32(buf) {
    const t = this._crc32Table();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = (crc>>>8)^t[(crc^buf[i])&0xFF];
    return (crc^0xFFFFFFFF)>>>0;
  }

  _crc32Table() {
    if (this._table) return this._table;
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c&1) ? (0xEDB88320^(c>>>1)) : (c>>>1);
      t[i] = c;
    }
    return (this._table = t);
  }
}

module.exports = WpAdminService;
