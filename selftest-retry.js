'use strict';

// Offline unit test for auto-resend on a mid-transfer disconnect.
const assert = require('assert');
const { PairDropNode } = require('./client');
const cfg = require('./config');

function makeNode() {
  const n = new PairDropNode();
  n.pendingFile = {
    name: 'x.bin',
    mime: 'application/octet-stream',
    size: 10,
    buffer: Buffer.alloc(10)
  };
  n._resolve = () => {};
  n._reject = () => {};
  n.retryCount = 0;
  n.state = 'sending';
  n.dc = { close() {}, isOpen: () => false };
  n.pc = { close() {} };
  return n;
}

// 1. A drop must arm a resend instead of failing the caller's Promise.
const n1 = makeNode();
let scheduled = null;
n1.on('retry-scheduled', d => { scheduled = d; });
n1._resetPeer(true);
assert.strictEqual(n1.state, 'waiting-peer', 'must wait for reconnect');
assert.strictEqual(n1.retryCount, 1, 'one retry consumed');
assert(scheduled && scheduled.attempt === 1, 'retry event emitted');
console.log('case 1: drop arms auto-resend OK');

// 2. When the DataChannel reopens, the whole request must be re-issued.
const sent = [];
const fakeDc = {
  close() {},
  isOpen: () => true,
  sendMessage: m => { sent.push(JSON.parse(m)); return true; },
  setBufferedAmountLowThreshold() {},
  onOpen(cb) { this._open = cb; },
  onMessage() {},
  onClosed() {},
  onError() {},
  onBufferedAmountLow() {}
};
n1.dc = fakeDc;
n1._bindChannel(fakeDc);
fakeDc._open();
assert.strictEqual(n1.state, 'waiting-response', 'request must be re-issued');
assert(sent.some(m => m.type === 'request'), 'request message must be resent');
console.log('case 2: reconnect auto-resends request OK');

// 3. Duplicate peer-left events (ip + secret rooms) must not double count.
n1.state = 'waiting-peer';
n1._resetPeer(true);
assert.strictEqual(n1.retryCount, 1, 'duplicate disconnect must not consume a retry');
console.log('case 3: duplicate disconnect ignored OK');

// 4. Exhausting retries ends with an explicit failure, never a hang.
const n2 = makeNode();
n2.retryCount = cfg.MAX_SEND_RETRIES;
let failed = null;
n2.on('failed', r => { failed = r; });
n2._resetPeer(true);
assert.strictEqual(n2.state, 'failed', 'must fail explicitly');
assert(failed && /retries exhausted/.test(failed.error), 'clear failure reason');
console.log('case 4: retry limit fails explicitly OK');

console.log('\nRETRY SELFTEST PASSED');
process.exit(0);
