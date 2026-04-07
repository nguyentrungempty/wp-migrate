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

    // Wait and verify plugin is now active — use browser cookies to avoid 406
    await new Promise(r => setTimeout(r, 2000));

    // Try ping first
    let nowActive = await this._isPluginActive(session);

    // If ping fails due to hosting restrictions (406 etc), get browser cookies and retry
    if (!nowActive) {
      this.log('Ping failed, verifying via browser cookies...');
      try {
        const cookies = await this._getBrowserCookies(session);
        const res = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': this._cookieHeader(cookies),
          },
          timeout: 15000,
        }, 'action=wpm_ping');
        const body = res.text().trim();
        this.log('Plugin verify with cookies: status=' + res.status + ' body=' + body.slice(0, 80));
        nowActive = res.status === 200 && body.includes('"success":true');
      } catch(e) {
        this.log('Cookie verify error: ' + e.message);
      }
    }

    if (!nowActive) {
      throw new Error('Plugin uploaded but not responding on ' + session.siteUrl + ' — kiểm tra WP Admin > Plugins');
    }
    this.log('✓ wpm-helper installed and active on ' + session.siteUrl);
  }

  async _deactivateBlockingPlugins(page, siteUrl) {
    // Deactivate ALL active plugins temporarily before installing wpm-helper
    // This prevents any plugin from blocking the install process
    // They will be reactivated right after
    try {
      await page.goto(siteUrl + '/wp-admin/plugins.php', { waitUntil: 'networkidle2' });

      const rows = await page.$$eval('tr.active[data-slug]', els => els.map(el => ({
        slug: el.getAttribute('data-slug'),
        href: (el.querySelector('a[href*="action=deactivate"]') || {}).href || '',
      })));

      const deactivated = [];
      for (const row of rows) {
        if (!row.href || row.slug === 'wpm-helper') continue;
        await page.goto(row.href, { waitUntil: 'networkidle2' });
        deactivated.push(row.slug);
        this.log('Browser: deactivated: ' + row.slug);
      }

      this.log('Browser: deactivated ' + deactivated.length + ' plugins before install');
      return deactivated;
    } catch(e) {
      this.log('Browser: deactivate failed: ' + e.message);
      return [];
    }
  }

  async _reactivatePlugins(page, siteUrl, slugs) {
    try {
      await page.goto(siteUrl + '/wp-admin/plugins.php', { waitUntil: 'networkidle2' });
      for (const slug of slugs) {
        const activateLink = await page.$('tr[data-slug="' + slug + '"] a[href*="action=activate"]');
        if (activateLink) {
          const href = await page.evaluate(el => el.href, activateLink);
          await page.goto(href, { waitUntil: 'networkidle2' });
          this.log('Browser: reactivated plugin: ' + slug);
          await page.goto(siteUrl + '/wp-admin/plugins.php', { waitUntil: 'networkidle2' });
        }
      }
    } catch(e) {
      this.log('Browser: reactivate failed: ' + e.message);
    }
  }

  async _isPluginActive(session) {
    try {
      const res  = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 15000,
      }, 'action=wpm_ping');
      const body = res.text().trim();
      this.log('Plugin ping: status=' + res.status + ' body=' + body.slice(0, 80));
      if (res.status === 200 && body.includes('"success":true')) return true;
      // 406 = hosting blocks non-standard requests, try with cookie
      if (res.status === 406 && session.cookies && Object.keys(session.cookies).length > 0) {
        const res2 = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': '*/*',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': this._cookieHeader(session.cookies),
          },
          timeout: 15000,
        }, 'action=wpm_ping');
        const body2 = res2.text().trim();
        this.log('Plugin ping (with cookie): status=' + res2.status + ' body=' + body2.slice(0, 80));
        return res2.status === 200 && body2.includes('"success":true');
      }
      return false;
    } catch(e) {
      this.log('Plugin ping error: ' + e.message);
      return false;
    }
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

      // ── 2.5: Deactivate plugins that may block upload ─────────────────────
      // Some premium plugins block plugin uploads (e.g. security/license plugins)
      // We temporarily deactivate them, install wpm-helper, then reactivate
      const deactivated = await this._deactivateBlockingPlugins(page, session.siteUrl);

      // ── 3. Navigate to plugin upload page ────────────────────────────────────
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
      this.log('Browser: install page HTML snippet: ' + html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0, 500));

      if (html.includes('already installed') || html.includes('Plugin already installed')) {
        this.log('Plugin already installed, proceeding to activate...');
      } else if (html.includes('Installation failed') || html.includes('Plugin installation failed')) {
        const errText = (
          html.match(/id="message"[^>]*>([\s\S]{0,400})<\/div>/)?.[1] ||
          html.match(/class="[^"]*error[^"]*"[^>]*>([\s\S]{0,400})<\/[^>]+>/)?.[1] ||
          html.match(/<p>([\s\S]{0,300})<\/p>/)?.[1] ||
          html.slice(0, 500)
        ).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new Error('Install failed: ' + errText);
      } else if (!html.includes('wpm-helper') && !html.includes('action=activate')) {
        // Unknown state — try to continue anyway
        this.log('Browser: install result unclear, continuing...');
      }

      // ── 4. Activate ───────────────────────────────────────────────────────
      // Log all activate links found on current page for debug
      const allLinks = await page.$$eval('a', els => els.map(a => a.href).filter(h => h.includes('activate')));
      this.log('Browser: activate links on result page: ' + JSON.stringify(allLinks.slice(0,5)));

      // Try any activate link on install result page
      const activateBtn = await page.$('a[href*="action=activate"]');
      if (activateBtn) {
        this.log('Browser: clicking activate on result page...');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2' }),
          activateBtn.click(),
        ]);
        this.log('Browser: activated, now at ' + page.url());
      } else {
        // Navigate to plugins list and find activation link
        this.log('Browser: no activate link on result page, going to plugins.php...');
        await page.goto(session.siteUrl + '/wp-admin/plugins.php', { waitUntil: 'networkidle2' });

        // Log all rows with wpm in slug for debug
        const pluginRows = await page.$$eval('tr[data-slug]', els => els.map(el => el.getAttribute('data-slug')));
        this.log('Browser: plugin rows found: ' + pluginRows.join(', '));

        // Try multiple selectors
        const activateSelectors = [
          'tr[data-slug="wpm-helper"] a[href*="action=activate"]',
          'tr[data-slug="wpm-helper\/wpm-helper"] a[href*="action=activate"]',
          'a[href*="plugin=wpm-helper"][href*="action=activate"]',
          'a[href*="wpm-helper"][href*="activate"]',
        ];

        let activated = false;
        for (const sel of activateSelectors) {
          const el = await page.$(sel);
          if (el) {
            this.log('Browser: found activate link with selector: ' + sel);
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle2' }),
              el.click(),
            ]);
            this.log('Browser: activated from plugins list');
            activated = true;
            break;
          }
        }

        if (!activated) {
          // Check if already active (no activate link = already active)
          const isActive = await page.$('tr.active[data-slug="wpm-helper"], tr.active[data-plugin="wpm-helper/wpm-helper.php"]');
          if (isActive) {
            this.log('Browser: plugin already active');
          } else {
            // Last resort: get href directly from page and navigate
            const activateHref = await page.evaluate(function() {
              var links = Array.from(document.querySelectorAll('a'));
              var link = links.find(function(a) { return a.href.includes('wpm') && a.href.includes('activate'); });
              return link ? link.href : null;
            });
            if (activateHref) {
              this.log('Browser: found activate href via evaluate: ' + activateHref);
              await page.goto(activateHref, { waitUntil: 'networkidle2' });
              this.log('Browser: activated via direct navigation');
            } else {
              // Dump page content for debug
              const pluginsHtml = await page.content();
              this.log('Browser: wpm-helper section: ' + (pluginsHtml.match(/wpm[\s\S]{0,500}/)?.[0]?.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() || 'NOT FOUND'));
              throw new Error('Cannot find activate link for wpm-helper on plugins.php');
            }
          }
        }
      }

      this.log('Browser: installation complete');

      // Reactivate any plugins we deactivated
      if (deactivated && deactivated.length > 0) {
        await this._reactivatePlugins(page, session.siteUrl, deactivated);
      }
    } finally {
      await browser.close();
    }
  }

  // ── Backup ────────────────────────────────────────────────────────────────

  async createBackup(session, jobId) {
    this.log('Creating backup on ' + session.siteUrl + '...');

    // Get valid cookies from real browser login (bypasses SameSite restriction)
    const cookies = await this._getBrowserCookies(session);
    this.log('Got ' + Object.keys(cookies).length + ' browser cookies for backup');

    const res = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': this._cookieHeader(cookies),
        'Referer': session.siteUrl + '/wp-admin/',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 600000,
    }, 'action=wpm_create_backup&job_id=' + encodeURIComponent(jobId));

    const raw = res.text();
    this.log('Backup response: ' + raw.slice(0, 300));
    if (!raw || raw === '0' || raw === '-1') throw new Error('Backup AJAX failed: ' + (raw || 'empty'));
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('Backup not JSON: ' + raw.slice(0, 200)); }
    if (!data.success) throw new Error('Backup error: ' + (data.data || JSON.stringify(data)));
    this.log('✓ Backup: ' + data.data.file + ' (' + Math.round((data.data.size||0)/1024/1024) + 'MB, db_size=' + Math.round((data.data.db_size||0)/1024) + 'KB, tables=' + (data.data.db_tables||'?') + ')');
    return data.data;
  }

  // ── Download backup ───────────────────────────────────────────────────────

  async downloadBackup(session, backupInfo, destPath) {
    this.log('Downloading backup: ' + backupInfo.file + ' (' + Math.round((backupInfo.size||0)/1024/1024) + 'MB)');

    // Get real browser cookies (bypasses SameSite)
    const cookies = await this._getBrowserCookies(session);
    this.log('Got ' + Object.keys(cookies).length + ' browser cookies for download');

    // Download via AJAX endpoint (bypasses .htaccess deny on uploads dir)
    const ajaxUrl = session.siteUrl + '/wp-admin/admin-ajax.php'
      + '?action=wpm_download_backup&file=' + encodeURIComponent(backupInfo.file);

    const res = await this._request(ajaxUrl, {
      headers: { 'Cookie': this._cookieHeader(cookies) },
      timeout: 600000,
    });

    this.log('Download status: ' + res.status + ', size: ' + res.body.length);

    if (res.status === 200 && res.body.length > 10000) {
      fs.writeFileSync(destPath, res.body);
      this.log('✓ Downloaded: ' + Math.round(res.body.length/1024/1024) + 'MB');
      return;
    }

    // Log response for debug
    const preview = res.text().slice(0, 200);
    this.log('Download response preview: ' + preview);
    throw new Error('Download failed: HTTP ' + res.status + ', size=' + res.body.length);
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  async uploadAndRestore(session, zipPath, oldDomain, newDomain) {
    this.log('Restoring to ' + session.siteUrl + ' ...');
    const zipSize = fs.statSync(zipPath).size;
    this.log('Backup size: ' + Math.round(zipSize/1024/1024) + 'MB');

    // Get valid cookies from browser (bypasses SameSite), then use HTTP for upload
    const cookies = await this._getBrowserCookies(session);
    this.log('Got ' + Object.keys(cookies).length + ' cookies from browser');

    // Get nonce using browser cookies via HTTP
    let nonce = 'no-nonce';
    try {
      const nr  = await this._request(session.siteUrl + '/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': this._cookieHeader(cookies) },
        timeout: 15000,
      }, 'action=wpm_get_nonce');
      const nd = JSON.parse(nr.text());
      if (nd.success) { nonce = nd.data; this.log('Got nonce: ' + nonce); }
    } catch(e) { this.log('Nonce error: ' + e.message); }

    // Upload via HTTP multipart using browser cookies
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
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Cookie': this._cookieHeader(cookies),
        'Referer': session.siteUrl + '/wp-admin/',
      },
      timeout: 600000,
    }, Buffer.concat(parts));

    const raw = res.text();
    this.log('Restore response (' + raw.length + ' chars): ' + raw.slice(0, 500));
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('Restore not JSON: ' + raw.slice(0, 300)); }
    if (!data.success) throw new Error('Restore error: ' + JSON.stringify(data.data || data));

    // Log restore details
    if (data.data && data.data.log) {
      data.data.log.forEach(line => this.log('  [restore] ' + line));
    }
    this.log('✓ Restore completed on ' + session.siteUrl);
  }

  // Get valid session cookies by logging in via real browser
  async _getBrowserCookies(session) {
    let puppeteer;
    try { puppeteer = require('puppeteer'); } catch { throw new Error('Puppeteer not installed'); }

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],
      ignoreHTTPSErrors: true,
    });
    const page = await browser.newPage();
    try {
      await page.goto(session.siteUrl + '/wp-login.php', { waitUntil: 'networkidle2' });
      await page.type('#user_login', session.username, { delay: 20 });
      await page.type('#user_pass',  session.password,  { delay: 20 });
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#wp-submit')]);
      const cookies = await page.cookies();
      const cookieMap = {};
      cookies.forEach(c => { cookieMap[c.name] = c.value; });
      return cookieMap;
    } finally {
      await browser.close();
    }
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
