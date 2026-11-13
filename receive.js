'use strict';

// Minimal receive-only resident process (no HTTP server).
// Run it, then send a file from the phone to the "robinspark" device.
const fs = require('fs');
const cfg = require('./config');
const { PairDropNode } = require('./client');

const node = new PairDropNode();

node.on('peer-online', info => console.log('phone online: ' + info.name));
node.on('file-received', record => {
  console.log('RECEIVED ' + JSON.stringify(record));
  try {
    fs.writeFileSync(cfg.RECEIVED_FILE, JSON.stringify(node.received, null, 2));
  } catch (_) {}
});

node.connect();
console.log('receive-only mode; files will be saved to ' + cfg.INBOX_DIR);

process.on('SIGINT', () => {
  node.close();
  process.exit(0);
});
