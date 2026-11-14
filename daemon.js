'use strict';

// Resident service for BOTH directions. One HTTP call returns the final result
// immediately; the process then auto-exits when idle/offline so it never hangs
// in the background consuming memory. Restart on demand (ask.js does it).
//
//   curl -X POST http://127.0.0.1:18731/send \
//        -H "Content-Type: application/json" \
//        -d "{\"path\":\"E:\\\\Desktop\\\\photo.png\"}"
//   curl -X POST http://127.0.0.1:18731/receive
//   curl http://127.0.0.1:18731/inbox
//   curl http://127.0.0.1:18731/status

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { PairDropNode } = require('./client');
const { attachExitPolicy } = require('./keepalive');
const { log, error } = require('./log');

const node = new PairDropNode();
node.connect();

let current = null;
let receiveWaiters = [];
let shuttingDown = false;
let server = null;

function json(res, code, payload) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  } catch (_) {}
}

function pendingCount() {
  return (current ? 1 : 0) + receiveWaiters.length;
}

// Called by the exit policy. Returning false vetoes the exit.
function onAutoExit(reason) {
  if (pendingCount() > 0) {
    log('deferring auto-exit (' + reason + '): ' + pendingCount() + ' request(s) pending');
    return false;
  }
  shutdown(reason);
  return true;
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('daemon shutting down: ' + reason);
  receiveWaiters.splice(0).forEach(w => {
    clearTimeout(w.timer);
    json(w.res, 200, { ok: false, error: 'daemon shutting down' });
  });
  try { node.close(); } catch (_) {}
  const bye = () => process.exit(0);
  if (server) server.close(bye);
  else bye();
  setTimeout(bye, 1500); // fallback if a socket lingers
}

const policy = attachExitPolicy(node, onAutoExit, {
  idleMs: cfg.DAEMON_IDLE_MS,
  disconnectMs: cfg.DISCONNECT_GRACE_MS,
  maxMs: cfg.DAEMON_MAX_SESSION_MS,
  startArmed: true
});

// Only resume the idle countdown once every hanging request has been answered.
function requestDone(label) {
  if (pendingCount() > 0) return;
  policy.resume(label);
}

function finish(result) {
  if (!current) return;
  const entry = current;
  current = null;
  clearTimeout(entry.timer);
  const payload = Object.assign({ at: new Date().toISOString() }, result);
  try { fs.writeFileSync(cfg.RESULT_FILE, JSON.stringify(payload, null, 2)); } catch (_) {}
  json(entry.res, 200, payload); // result goes out NOW, before any shutdown logic
  requestDone('send request complete');
}

node.on('file-received', record => {
  try {
    fs.writeFileSync(cfg.RECEIVED_FILE, JSON.stringify(node.received, null, 2));
  } catch (_) {}
  const waiting = receiveWaiters;
  receiveWaiters = [];
  waiting.forEach(w => {
    clearTimeout(w.timer);
    json(w.res, 200, { ok: true, file: record, at: new Date().toISOString() });
  });
  requestDone('incoming file delivered');
});

server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    json(res, 200, {
      online: !!node.targetPeerId,
      channelOpen: !!(node.dc && node.dc.isOpen()),
      state: node.state,
      receiving: node.receiver.busy,
      receivedCount: node.received.length,
      idleExitMs: cfg.DAEMON_IDLE_MS,
      inbox: cfg.INBOX_DIR
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/inbox') {
    json(res, 200, { ok: true, count: node.received.length, files: node.received });
    return;
  }

  if (req.method === 'POST' && req.url === '/receive') {
    if (receiveWaiters.length >= 4) {
      json(res, 409, { ok: false, error: 'too many pending receive waiters' });
      return;
    }
    policy.suspend();
    const entry = { res: res, timer: null };
    entry.timer = setTimeout(() => {
      const i = receiveWaiters.indexOf(entry);
      if (i >= 0) receiveWaiters.splice(i, 1);
      error('receive wait timeout');
      json(res, 200, { ok: false, error: 'receive wait timeout' });
      requestDone('receive wait timeout');
    }, cfg.WAIT_TIMEOUT_MS);
    receiveWaiters.push(entry);
    log('receive waiter registered');
    return;
  }

  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let filePath;
      try { filePath = JSON.parse(body).path; } catch (_) {}
      if (!filePath) {
        json(res, 400, { ok: false, error: 'missing path' });
        return;
      }
      if (current) {
        json(res, 409, { ok: false, error: 'another transfer in progress' });
        return;
      }
      if (node.receiver.busy) {
        json(res, 409, { ok: false, error: 'currently receiving; retry when idle' });
        return;
      }

      log('INCOMING REQUEST ' + filePath);
      policy.suspend();
      const timer = setTimeout(() => {
        error('daemon wait timeout');
        finish({ ok: false, error: 'daemon wait timeout' });
      }, cfg.SEND_TOTAL_MS);
      current = { res: res, timer: timer, path: filePath };

      node.sendFile(path.resolve(filePath))
        .then(finish)
        .catch(e => finish({ ok: false, error: e.message }));
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

// A single request may legitimately stay open while waiting for the phone.
server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(cfg.CONTROL_PORT, cfg.CONTROL_HOST, () => {
  log('daemon ready at http://' + cfg.CONTROL_HOST + ':' + cfg.CONTROL_PORT +
      ' idleExit=' + cfg.DAEMON_IDLE_MS + 'ms inbox=' + cfg.INBOX_DIR);
});

process.on('SIGINT', () => shutdown('SIGINT'));
