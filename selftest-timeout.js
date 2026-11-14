'use strict';

// Verifies: 5-minute peer wait, progress-based (not fixed) transfer timeout,
// and receive-side stall cleanup.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const { PairDropNode } = require('./client');
const { IncomingTransfer } = require('./receiver');

cfg.INBOX_DIR = path.join(os.tmpdir(), 'pairdrop-selftest-' + Date.now());
fs.mkdirSync(cfg.INBOX_DIR, { recursive: true });

// 1. Timing configuration.
assert.strictEqual(cfg.PEER_WAIT_MS, 5 * 60 * 1000, 'peer wait must be 5 min');
assert(cfg.TRANSFER_TIMEOUT_MS > 5 * 60 * 1000, 'transfer cap must exceed 5 min');
assert(cfg.TRANSFER_STALL_MS < cfg.TRANSFER_TIMEOUT_MS, 'stall must be shorter');
console.log('case 1: peer wait 5 min + stall-based transfer timeout OK');

// 2. Progress refreshes the watchdog instead of a fixed 5-minute kill.
const n = new PairDropNode();
n.pendingFile = { name: 'big.bin', mime: 'x', size: 100 * 1024 * 1024, buffer: Buffer.alloc(1) };
n.state = 'sending';
n._resolve = () => {};
n._reject = () => {};
n.transferDeadline = Date.now() + cfg.TRANSFER_TIMEOUT_MS;
n._refreshTransferTimeout();
const firstTimer = n.timeout;
n._onDcMessage(JSON.stringify({ type: 'progress', progress: 0.1 }));
assert.notStrictEqual(n.timeout, firstTimer, 'progress must refresh the stall timer');
assert.strictEqual(n.state, 'sending', 'a large file must not be failed early');
console.log('case 2: progress keeps a large transfer alive OK');

// 3. Absolute cap still fires.
n.transferDeadline = Date.now() - 1;
n._refreshTransferTimeout();
assert.strictEqual(n.state, 'failed', 'absolute cap must still fail');
console.log('case 3: absolute transfer cap OK');

// 4. Receive side resets a half-finished transfer after a stall.
let stalledName = null;
const recv = new IncomingTransfer(
  () => true,
  () => {},
  { stallMs: 40, onStall: name => { stalledName = name; } }
);
recv.onMessage({ type: 'request', header: [{ name: 'half.bin', size: 100 }], totalSize: 100 });
recv.onMessage({ type: 'header', name: 'half.bin', size: 100, mime: 'x' });
recv.onChunk(Buffer.alloc(10));
assert.strictEqual(recv.busy, true, 'receiver starts busy');

setTimeout(() => {
  assert.strictEqual(recv.busy, false, 'stall must reset receiver to idle');
  assert.strictEqual(stalledName, 'half.bin', 'stall callback must fire');
  assert(!fs.existsSync(path.join(cfg.INBOX_DIR, 'half.bin')),
    'partial file must be removed on abort');
  recv.onMessage({ type: 'request', header: [{ name: 'next.bin', size: 1 }], totalSize: 1 });
  assert.strictEqual(recv.active, true, 'a new request must be accepted after a stall');
  recv.abort();
  console.log('case 4: receive stall cleanup OK');
  console.log('\nTIMEOUT SELFTEST PASSED');
  fs.rmSync(cfg.INBOX_DIR, { recursive: true, force: true });
  process.exit(0);
}, 150);
