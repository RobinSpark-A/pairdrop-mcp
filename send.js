'use strict';

// One-shot sender: node send.js <absolute-or-relative-file-path>
// Prints RESULT immediately on success but keeps the connection alive for a
// short window (see keepalive.js) before exiting automatically.
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const { PairDropNode } = require('./client');
const { attachExitPolicy } = require('./keepalive');

const file = process.argv[2];
if (!file) {
  console.error('usage: node send.js <file>');
  process.exit(2);
}

const node = new PairDropNode();
let succeeded = false;

function shutdown() {
  node.close();
  process.exit(succeeded ? 0 : 1);
}

const policy = attachExitPolicy(node, shutdown);
node.connect();

// While the channel stays open after a send, the phone may also push a file
// back. Record it and reset the idle timer.
node.on('file-received', record => {
  console.log('RECEIVED ' + JSON.stringify(record));
  try {
    fs.writeFileSync(cfg.RECEIVED_FILE, JSON.stringify(node.received, null, 2));
  } catch (_) {}
  policy.activity('incoming file ' + record.name);
});

node.sendFile(path.resolve(file))
  .then(result => {
    succeeded = true;
    console.log('RESULT ' + JSON.stringify(result));
    try {
      fs.writeFileSync(cfg.RESULT_FILE, JSON.stringify(
        Object.assign({ at: new Date().toISOString() }, result), null, 2));
    } catch (_) {}
    policy.activity('send complete');
  })
  .catch(err => {
    console.error('FAILED ' + err.message);
    policy.exit('send failed');
  });
