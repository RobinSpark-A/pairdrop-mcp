'use strict';

// One-call client. Starts daemon.js on demand (it auto-exits when idle), waits
// for ONE result over HTTP, prints it and exits. So:
//   - the result comes back the moment the transfer finishes (HTTP response)
//   - nothing stays in the background afterwards
//   - the next call transparently starts a fresh daemon
//
//   node ask.js send "E:/Desktop/photo.png"
//   node ask.js receive
//   node ask.js inbox
//   node ask.js status

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const cfg = require('./config');
const bootstrap = require('./bootstrap');

const action = (process.argv[2] || 'status').toLowerCase();
const arg = process.argv[3];

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: cfg.CONTROL_HOST,
      port: cfg.CONTROL_PORT,
      method: method,
      path: urlPath,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {}
    }, res => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (_) {
          resolve({ ok: false, error: 'malformed response', raw: buf.slice(0, 200) });
        }
      });
    });
    // A hanging /receive or /send can legitimately be quiet for 10 minutes.
    req.setTimeout(cfg.WAIT_TIMEOUT_MS + 60000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function ping() {
  return request('GET', '/status').then(() => true).catch(() => false);
}

function startDaemon() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env
    });
    child.on('error', reject);
    child.unref();

    // Brief startup handshake only (a few hundred ms). This is NOT a poll
    // while waiting for the phone - that wait happens inside one HTTP request.
    let tries = 0;
    const check = () => {
      ping().then(ok => {
        if (ok) return resolve();
        if (++tries >= 25) return reject(new Error('daemon failed to start'));
        setTimeout(check, 150);
      }).catch(reject);
    };
    setTimeout(check, 200);
  });
}

(async () => {
  // Auto-create local.json / inbox / deps on a brand-new machine.
  await bootstrap.ensureReady();
  if (!(await ping())) await startDaemon();

  let result;
  switch (action) {
    case 'send':
      if (!arg) throw new Error('usage: node ask.js send <file>');
      result = await request('POST', '/send', { path: arg });
      break;
    case 'receive':
      result = await request('POST', '/receive');
      break;
    case 'inbox':
      result = await request('GET', '/inbox');
      break;
    default:
      result = await request('GET', '/status');
  }

  console.log('RESULT ' + JSON.stringify(result));
  process.exit(result && result.ok === false ? 1 : 0);
})().catch(err => {
  console.error('FAILED ' + err.message);
  process.exit(1);
});
