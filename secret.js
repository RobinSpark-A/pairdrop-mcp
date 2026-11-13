'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

function scanIndexedDb() {
  const roots = [];
  if (fs.existsSync(cfg.INDEXEDDB_ROOT)) {
    for (const name of fs.readdirSync(cfg.INDEXEDDB_ROOT)) {
      if (name.toLowerCase().includes('pairdrop')) {
        const dir = path.join(cfg.INDEXEDDB_ROOT, name);
        if (fs.statSync(dir).isDirectory()) roots.push(dir);
      }
    }
  }

  const found = new Set();
  for (const dir of roots) {
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(log|ldb)$/.test(file)) continue;
      let raw;
      try {
        raw = fs.readFileSync(path.join(dir, file)).toString('latin1');
      } catch (_) {
        continue;
      }
      for (const m of raw.match(/[\x20-\x7E]{64,256}/g) || []) {
        if (!m.includes('"')) found.add(m);
      }
      for (const m of raw.match(/(?:[\x20-\x7E]\x00){64,256}/g) || []) {
        const v = m.replace(/\x00/g, '');
        if (!v.includes('"')) found.add(v);
      }
    }
  }
  return [...found];
}

function getSecret() {
  if (fs.existsSync(cfg.SECRET_FILE)) {
    const saved = fs.readFileSync(cfg.SECRET_FILE, 'utf8').trim();
    if (saved.length >= cfg.SECRET_MIN && saved.length <= cfg.SECRET_MAX) {
      return { secret: saved, source: 'secret.txt' };
    }
  }

  const candidates = scanIndexedDb()
    .filter(s => s.length >= cfg.SECRET_MIN && s.length <= cfg.SECRET_MAX)
    .filter(s => /^[\x00-\x7F]+$/.test(s))
    .sort((a, b) => b.length - a.length);

  if (candidates.length === 0) {
    throw new Error('No paired roomSecret found in Chrome IndexedDB. Run `npm run pair` once to create a new pairing.');
  }

  const secret = candidates[0];
  fs.writeFileSync(cfg.SECRET_FILE, secret, 'utf8');
  return { secret, source: 'chrome-indexeddb' };
}

module.exports = { getSecret, scanIndexedDb };
