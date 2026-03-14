#!/usr/bin/env node
/**
 * setup.js — chạy 1 lần để cài Chrome cho Puppeteer
 * Usage: node setup.js
 */
'use strict';

const { execSync } = require('child_process');

console.log('\n=== WP Migrator Pro — Setup ===\n');

// Install system deps for Chrome on Ubuntu/Debian
console.log('[1/2] Installing system dependencies...');
try {
  execSync('apt-get install -y -q ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils 2>&1', { stdio: 'inherit' });
} catch(e) {
  console.log('Warning: some deps may have failed, continuing...');
}

console.log('[2/2] Installing Puppeteer + Chrome...');
try {
  execSync('npm install', { stdio: 'inherit', cwd: __dirname });
} catch(e) {
  console.error('npm install failed:', e.message);
  process.exit(1);
}

console.log('\n✓ Setup complete! Run: PORT=3001 node server.js\n');
