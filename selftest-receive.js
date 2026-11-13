'use strict';

// Offline unit test for the receive state machine. No browser, no phone, no
// network: inject the exact wire messages and verify ACKs + bytes on disk.
const fs = require('fs');
const assert = require('assert');
const { PairDropNode } = require('./client');
const cfg = require('./config');

const node = new PairDropNode();
const sent = [];
node._sendJSON = m => { sent.push(m); return true; };

const SIZE = 1200000; // > 1,000,000 so the partition path is exercised
const payload = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) payload[i] = i % 251;

// A deliberately hostile file name to verify path sanitisation.
const REMOTE_NAME = '../evil test.png';

node._onDcMessage(JSON.stringify({
  type: 'request',
  header: [{ name: REMOTE_NAME, mime: 'image/png', size: SIZE }],
  totalSize: SIZE,
  imagesOnly: true,
  thumbnailDataUrl: ''
}));
node._onDcMessage(JSON.stringify({
  type: 'header', name: REMOTE_NAME, mime: 'image/png', size: SIZE
}));

for (let off = 0; off < SIZE; off += cfg.CHUNK_SIZE) {
  node.receiver.onChunk(payload.subarray(off, Math.min(off + cfg.CHUNK_SIZE, SIZE)));
}

node._onDcMessage(JSON.stringify({ type: 'partition', offset: 1000000 }));

setTimeout(() => {
  const types = sent.map(m => m.type);
  console.log('messages sent: ' + JSON.stringify(types));

  const response = sent.find(m => m.type === 'files-transfer-response');
  assert(response && response.accepted === true, 'must auto-accept');
  assert(types.includes('partition-received'), 'must ACK partition or the phone stalls');
  assert(types.includes('file-transfer-complete'), 'must confirm every file');
  assert(types.filter(t => t === 'progress').length >= 2, 'should report progress');

  assert.strictEqual(node.received.length, 1, 'one file recorded');
  const record = node.received[0];
  assert.strictEqual(record.complete, true, 'size check passed');
  assert.strictEqual(record.size, SIZE, 'byte count matches');
  assert.strictEqual(record.name, 'evil test.png', 'path traversal sanitised');
  assert(!record.path.includes('..'), 'no parent path in destination');
  assert(fs.readFileSync(record.path).equals(payload), 'bytes are identical');

  console.log('\nRECEIVE SELFTEST PASSED ' + JSON.stringify({
    file: record.path,
    size: record.size,
    messages: sent.length
  }));

  // Clean up so the test file does not look like a real received file.
  try { fs.unlinkSync(record.path); } catch (_) {}
  process.exit(0);
}, 1500);
