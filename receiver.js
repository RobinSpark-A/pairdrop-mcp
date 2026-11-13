'use strict';

// Receive side of the PairDrop wire protocol.
// Mirrors network.js: _onFilesTransferRequest / _onFileHeader / FileDigester /
// _onReceivedPartitionEnd / _onFileReceived, but streams straight to disk
// instead of buffering every chunk in memory like the browser client does.

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log, warn, error } = require('./log');

function uniquePath(name) {
  // A remote peer controls the file name. Strip any path component and unsafe
  // characters before it ever reaches the filesystem.
  const clean = path.basename(String(name)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'unnamed';
  fs.mkdirSync(cfg.INBOX_DIR, { recursive: true });
  let dest = path.join(cfg.INBOX_DIR, clean);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(clean);
  const base = path.basename(clean, ext);
  let i = 1;
  while (fs.existsSync(path.join(cfg.INBOX_DIR, base + '-' + i + ext))) i++;
  return path.join(cfg.INBOX_DIR, base + '-' + i + ext);
}

class IncomingTransfer {
  constructor(send, onFile) {
    this._send = send;
    this._onFile = onFile;
    this.active = false;
    this.files = [];
    this.totalSize = 0;
    this.index = 0;
    this.totalBytesReceived = 0;
    this.lastProgress = 0;
    this.current = null;
  }

  get busy() {
    return this.active || !!this.current;
  }

  onMessage(m) {
    switch (m.type) {
      case 'request':
        this._onRequest(m);
        break;
      case 'header':
        this._onHeader(m);
        break;
      case 'partition':
        // The sender stops and waits after every 1,000,000 bytes. Without this
        // ACK the phone silently stalls (the official client has no timeout).
        this._send({ type: 'partition-received', offset: m.offset });
        break;
      case 'text':
        // Text messages are not files; acknowledge so the sender can finish.
        this._send({ type: 'message-transfer-complete' });
        break;
      default:
        break;
    }
  }

  onChunk(msg) {
    if (!this.current) return;
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
    const cur = this.current;
    if (cur.finished) return;

    // Node's writable stream queues internally; disk writes are far faster
    // than the network path, so no explicit pause/resume is needed here.
    cur.stream.write(buf);
    cur.received += buf.length;

    const progress = this.totalSize > 0
      ? (this.totalBytesReceived + cur.received) / this.totalSize
      : 1;
    if (progress - this.lastProgress >= 0.25 || progress >= 1) {
      this.lastProgress = progress;
      this._send({ type: 'progress', progress: Math.min(progress, 1) });
    }

    if (cur.received >= cur.size) {
      cur.finished = true;
      cur.stream.end(() => this._finish());
    }
  }

  _onRequest(m) {
    if (this.active) {
      warn('rejecting incoming request: already receiving');
      this._send({ type: 'files-transfer-response', accepted: false });
      return;
    }
    const files = (m.header || []).map(h => ({
      name: String(h.name || 'unnamed'),
      mime: String(h.mime || 'application/octet-stream'),
      size: Number(h.size) || 0
    }));
    if (!files.length) {
      this._send({ type: 'files-transfer-response', accepted: false });
      return;
    }

    this.active = true;
    this.files = files;
    this.totalSize = Number(m.totalSize) || files.reduce((sum, f) => sum + f.size, 0);
    this.index = 0;
    this.totalBytesReceived = 0;
    this.lastProgress = 0;
    this.current = null;

    // No human confirmation needed on the node side: always auto-accept.
    this._send({ type: 'files-transfer-response', accepted: true });
    log('INCOMING accepted: ' + files.length + ' file(s), ' + this.totalSize + ' bytes');
  }

  _onHeader(m) {
    if (!this.active || this.current) return;
    const size = Number(m.size) || 0;
    const dest = uniquePath(m.name);
    let stream;
    try {
      stream = fs.createWriteStream(dest);
    } catch (e) {
      error('cannot open inbox file: ' + e.message);
      return;
    }
    stream.on('error', e => error('write error: ' + e.message));
    this.current = {
      name: path.basename(dest),
      requestedName: String(m.name || 'unnamed'),
      mime: String(m.mime || 'application/octet-stream'),
      size: size,
      received: 0,
      path: dest,
      stream: stream,
      finished: false
    };
    log('receiving -> ' + dest + ' (' + size + ' bytes)');
  }

  _finish() {
    if (!this.current) return;
    const cur = this.current;
    const complete = cur.received === cur.size;

    // Official client replies as soon as the file is complete, before its
    // own consistency check. Do the same.
    this._send({ type: 'file-transfer-complete' });

    const record = {
      name: cur.name,
      requestedName: cur.requestedName,
      mime: cur.mime,
      size: cur.received,
      path: cur.path,
      complete: complete,
      at: new Date().toISOString()
    };
    log('SAVED ' + cur.path + ' (' + cur.received + ' bytes)' +
        (complete ? '' : ' [SIZE MISMATCH]'));
    if (!complete) {
      // The protocol has no checksum. Size is the only integrity signal.
      error('size mismatch: expected ' + cur.size + ', got ' + cur.received);
    }

    this.totalBytesReceived += cur.received;
    this.current = null;
    this.index++;
    if (this._onFile) this._onFile(record);
    if (this.index >= this.files.length) {
      this.active = false;
      log('incoming transfer finished');
    }
  }

  abort() {
    if (this.current) {
      try { this.current.stream.destroy(); } catch (_) {}
      this.current = null;
    }
    this.active = false;
  }
}

module.exports = { IncomingTransfer, uniquePath };
