'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Only used by the optional "reuse an existing Chrome pairing" path. A new
// machine never needs it: setup.js / pair.js create a fresh pair secret.
function chromeIndexedDbRoot() {
  if (process.env.PAIRDROP_CHROME_IDB) return process.env.PAIRDROP_CHROME_IDB;
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'IndexedDB');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'IndexedDB');
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'google-chrome', 'Default', 'IndexedDB');
  }
  return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'IndexedDB');
}

const defaults = {
  // Signaling
  WS_URL: 'wss://pairdrop.net/server?webrtc_supported=true',
  DISPLAY_NAME: 'robinspark',
  // peers/peer-joined carry a server-generated random name. Custom names only
  // arrive later over DataChannel, so match by the secret room instead.
  TARGET_NAME: null,

  // Pairing secret (bearer credential, keep local)
  INDEXEDDB_ROOT: chromeIndexedDbRoot(),
  SECRET_FILE: path.join(__dirname, 'secret.txt'),
  SECRET_MIN: 64,
  SECRET_MAX: 256,

  // PairDrop wire protocol constants (network.js)
  DC_LABEL: 'data-channel',
  CHUNK_SIZE: 64000,
  PARTITION_SIZE: 1000000,
  FILES_QUEUE_TIMEOUT_MS: 30000,

  // Timing
  WAIT_TIMEOUT_MS: 10 * 60 * 1000,       // pairing / waiting for an incoming file
  PEER_WAIT_MS: 5 * 60 * 1000,           // send_file: wait for the phone to appear
  TRANSFER_TIMEOUT_MS: 30 * 60 * 1000,   // absolute cap for one whole transfer
  TRANSFER_STALL_MS: 90 * 1000,          // fail only if NO progress for this long
  RECEIVE_STALL_MS: 2 * 60 * 1000,       // receive side: reset a half-finished file
  SEND_TOTAL_MS: 60 * 60 * 1000,         // daemon / ask.js outer guard
  PONG_GRACE_MS: 4000,

  // One-shot CLI lifecycle AFTER a successful transfer
  POST_TRANSFER_KEEPALIVE_MS: 45 * 1000,
  DISCONNECT_GRACE_MS: 20 * 1000,
  MAX_SESSION_MS: 10 * 60 * 1000,
  DAEMON_IDLE_MS: Number(process.env.PAIRDROP_DAEMON_IDLE_MS) || 3 * 60 * 1000,
  DAEMON_MAX_SESSION_MS: 30 * 60 * 1000,
  // MCP server: release the PairDropNode (WS / WebRTC / heartbeat) when idle,
  // but keep the tiny stdio process alive so the client stays connected.
  MCP_IDLE_MS: Number(process.env.PAIRDROP_MCP_IDLE_MS) || 3 * 60 * 1000,

  // Auto-resend when the phone drops mid-transfer. Whole-file resend (the
  // protocol has no resume), bounded by count and a reconnect wait window.
  MAX_SEND_RETRIES: 3,
  RETRY_WAIT_MS: Number(process.env.PAIRDROP_RETRY_WAIT_MS) || 5 * 60 * 1000,

  // Local control interface
  CONTROL_HOST: '127.0.0.1',
  CONTROL_PORT: 18731,
  REQUEST_FILE: path.join(__dirname, 'inbox.json'),
  RESULT_FILE: path.join(__dirname, 'last-result.json'),
  LOG_FILE: path.join(__dirname, 'node.log'),

  // Receive side
  INBOX_DIR: path.join(__dirname, 'inbox'),
  RECEIVED_FILE: path.join(__dirname, 'received.json')
};

// local.json is generated automatically by bootstrap.js on a new machine.
// Only these keys may be overridden, so a stray file can never redirect the
// secret path or other security-sensitive settings.
const OVERRIDABLE = [
  'DISPLAY_NAME', 'CONTROL_HOST', 'CONTROL_PORT', 'INBOX_DIR',
  'DAEMON_IDLE_MS', 'WAIT_TIMEOUT_MS', 'TRANSFER_TIMEOUT_MS',
  'POST_TRANSFER_KEEPALIVE_MS', 'DISCONNECT_GRACE_MS', 'WS_URL'
];

try {
  const localFile = path.join(__dirname, 'local.json');
  if (fs.existsSync(localFile)) {
    const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    for (const key of OVERRIDABLE) {
      if (Object.prototype.hasOwnProperty.call(local, key)) defaults[key] = local[key];
    }
  }
} catch (_) {
  // A broken local.json must never stop the node from starting.
}

module.exports = defaults;
