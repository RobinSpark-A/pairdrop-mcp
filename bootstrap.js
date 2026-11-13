'use strict';

// Zero-touch first-run setup for a NEW machine / environment.
// Everything is automatic except one human action: entering the 6-digit code
// on the phone (or copying the phone's code into the setup call).
//
//   ensureReady()  -> deps, free port, display name, inbox dir, local.json
//   runPairing()   -> 6-digit pairing -> secret.txt
//   selfCheck()    -> verify the signaling + secret room work

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawnSync } = require('child_process');
const cfg = require('./config');

const LOCAL_FILE = path.join(__dirname, 'local.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function depsPresent() {
  try {
    require.resolve('ws');
    require.resolve('node-datachannel');
    return true;
  } catch (_) {
    return false;
  }
}

function ensureDeps() {
  if (depsPresent()) return { installed: false };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install'], {
    cwd: __dirname, encoding: 'utf8', timeout: 300000, windowsHide: true
  });
  if (result.status !== 0 || !depsPresent()) {
    throw new Error('npm install failed: ' + String(result.stderr || result.error || '').slice(0, 400));
  }
  return { installed: true };
}

function portIsFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, cfg.CONTROL_HOST);
  });
}

async function pickPort(start) {
  const base = Number(start) || 18731;
  for (let p = base; p < base + 30; p++) {
    if (await portIsFree(p)) return p;
  }
  throw new Error('no free local port found near ' + base);
}

async function ensureLocalConfig(opts = {}) {
  const wanted = opts.displayName
    ? String(opts.displayName).trim().slice(0, 64)
    : null;

  if (fs.existsSync(LOCAL_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
      // Allow renaming later too, without touching port / inbox / pairing.
      if (wanted && wanted !== existing.DISPLAY_NAME) {
        existing.DISPLAY_NAME = wanted;
        fs.writeFileSync(LOCAL_FILE, JSON.stringify(existing, null, 2));
      }
      Object.assign(cfg, existing);
      return { created: false, config: existing };
    } catch (_) {
      // regenerate a corrupt file
    }
  }
  const port = await pickPort(cfg.CONTROL_PORT);
  const hostname = os.hostname().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 16).toLowerCase();
  // If a pairing already exists, keep its display name: the phone may know
  // this device under that name. Only brand-new machines get a generated one.
  const alreadyPaired = fs.existsSync(cfg.SECRET_FILE);
  const local = {
    DISPLAY_NAME: wanted ||
      (alreadyPaired ? cfg.DISPLAY_NAME : 'pairdrop-' + (hostname || 'node')),
    CONTROL_PORT: port,
    INBOX_DIR: path.join(__dirname, 'inbox')
  };
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(local, null, 2));
  // Mutate the already-required config object so every module sees new values.
  Object.assign(cfg, local);
  return { created: true, config: local };
}

async function ensureReady(opts = {}) {
  const steps = [];
  const deps = ensureDeps();
  if (deps.installed) steps.push('npm install');

  const local = await ensureLocalConfig(opts);
  if (local.created) steps.push('local.json (port + display name)');

  fs.mkdirSync(cfg.INBOX_DIR, { recursive: true });
  if (!fs.existsSync(cfg.INBOX_DIR)) throw new Error('cannot create inbox dir');

  return {
    steps: steps,
    paired: fs.existsSync(cfg.SECRET_FILE),
    displayName: cfg.DISPLAY_NAME,
    port: cfg.CONTROL_PORT,
    inbox: cfg.INBOX_DIR
  };
}

// mode A: phone shows a 6-digit code -> user passes it in as `code`.
// mode B: node generates a code -> onCode reports it, user types it on phone.
function runPairing(opts = {}) {
  const WebSocket = require('ws'); // deps are guaranteed by ensureReady()
  const code = opts.code ? String(opts.code).trim() : null;
  const timeoutMs = opts.timeoutMs || cfg.WAIT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cfg.WS_URL, {
      headers: { Origin: 'https://pairdrop.net', 'User-Agent': UA }
    });
    let finished = false;
    let issuedCode = null;
    let guard = null;

    function finish(err, result) {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      try { ws.close(); } catch (_) {}
      if (err) {
        // secret.txt is written ONLY on pair-device-joined (success), so a
        // failed/expired pairing never leaves a partial secret behind. Never
        // delete the file here: it may belong to another successful pairing.
        reject(err);
      } else {
        resolve(result);
      }
    }

    guard = setTimeout(() => finish(new Error('pairing timeout')), timeoutMs);

    ws.on('message', data => {
      let m;
      try { m = JSON.parse(data.toString()); } catch (_) { return; }

      if (m.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (m.type === 'display-name') {
        ws.send(JSON.stringify(code
          ? { type: 'pair-device-join', pairKey: code }
          : { type: 'pair-device-initiate' }));
        return;
      }
      if (m.type === 'pair-device-initiated') {
        issuedCode = m.pairKey;
        if (opts.onCode) opts.onCode(m.pairKey);
        return;
      }
      if (m.type === 'pair-device-joined') {
        // Both modes deliver the roomSecret here. This is the authoritative
        // moment: the phone has actually joined the secret room.
        if (m.roomSecret) {
          fs.writeFileSync(cfg.SECRET_FILE, m.roomSecret, 'utf8');
        }
        if (!fs.existsSync(cfg.SECRET_FILE)) {
          finish(new Error('pairing completed without a roomSecret'));
          return;
        }
        finish(null, { mode: code ? 'phone-code' : 'node-code', code: issuedCode || code });
        return;
      }
      if (m.type === 'pair-device-join-key-invalid') {
        finish(new Error('invalid 6-digit code (check the phone and retry)'));
        return;
      }
      if (m.type === 'join-key-rate-limit') {
        finish(new Error('too many attempts; wait a few seconds and retry'));
        return;
      }
    });

    ws.on('error', e => finish(e));
  });
}

// Lightweight post-setup verification: connect, join rooms, report what we see.
function selfCheck(durationMs = 3000) {
  const WebSocket = require('ws');
  if (!fs.existsSync(cfg.SECRET_FILE)) {
    return Promise.reject(new Error('not paired yet'));
  }
  const secret = fs.readFileSync(cfg.SECRET_FILE, 'utf8').trim();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cfg.WS_URL, {
      headers: { Origin: 'https://pairdrop.net', 'User-Agent': UA }
    });
    const info = { signaling: false, rooms: [], peers: [], iceServers: 0 };

    ws.on('message', data => {
      let m;
      try { m = JSON.parse(data.toString()); } catch (_) { return; }
      if (m.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (m.type === 'ws-config') {
        info.signaling = true;
        info.iceServers = (m.wsConfig.rtcConfig.iceServers || []).length;
      } else if (m.type === 'display-name') {
        ws.send(JSON.stringify({ type: 'join-ip-room' }));
        ws.send(JSON.stringify({ type: 'room-secrets', roomSecrets: [secret] }));
      } else if (m.type === 'peers') {
        info.rooms.push(m.roomType);
        (m.peers || []).forEach(p => info.peers.push((p.name || {}).displayName));
      } else if (m.type === 'peer-joined') {
        info.peers.push(((m.peer || {}).name || {}).displayName);
      }
    });
    ws.on('error', e => reject(e));
    setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve(info);
    }, durationMs);
  });
}

module.exports = { ensureReady, ensureDeps, ensureLocalConfig, runPairing, selfCheck, LOCAL_FILE };
