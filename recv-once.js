'use strict';

// One-shot receiver: waits for an incoming transfer, prints a RESULT for each
// file, then keeps the channel alive briefly before exiting automatically.
//
//   node recv-once.js
//   -> RESULT {"ok":true,"file":{...}}   (printed immediately)
//   -> FAILED wait-for-file timeout       (only when nothing ever arrives)
//
// No immediate disconnect: file-transfer-complete has time to reach the phone,
// and the phone can send more files within the keepalive window.

const fs = require('fs');
const cfg = require('./config');
const { PairDropNode } = require('./client');
const { attachExitPolicy } = require('./keepalive');

const node = new PairDropNode();
let succeeded = false;
let waitTimer = null;

function shutdown() {
  if (waitTimer) clearTimeout(waitTimer);
  node.close();
  process.exit(succeeded ? 0 : 1);
}

const policy = attachExitPolicy(node, shutdown);
node.connect();

waitTimer = setTimeout(() => {
  if (!succeeded) {
    console.error('FAILED wait-for-file timeout');
    policy.exit('wait-for-file timeout');
  }
}, cfg.WAIT_TIMEOUT_MS);

node.on('file-received', record => {
  succeeded = true;
  if (waitTimer) {
    clearTimeout(waitTimer);
    waitTimer = null;
  }
  console.log('RESULT ' + JSON.stringify({ ok: true, file: record }));
  try {
    fs.writeFileSync(cfg.RECEIVED_FILE, JSON.stringify(node.received, null, 2));
  } catch (_) {}
  // Each file resets the idle timer, so a multi-file batch is never cut short.
  policy.activity('incoming file ' + record.name);
});
