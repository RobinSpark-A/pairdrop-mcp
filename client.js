'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { PeerConnection } = require('node-datachannel');
const cfg = require('./config');
const { getSecret } = require('./secret');
const { IncomingTransfer } = require('./receiver');
const { log, warn, error } = require('./log');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.md': 'text/markdown', '.zip': 'application/zip', '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg', '.json': 'application/json', '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function mimeOf(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// Convert browser-style RTCConfiguration into node-datachannel ICE url strings.
// TURN credentials are read fresh from ws-config on every connection, never hardcoded.
function toIceServers(rtcConfig) {
  const out = [];
  for (const entry of (rtcConfig && rtcConfig.iceServers) || []) {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    for (const u of urls) {
      if (!u || typeof u !== 'string') continue;
      const m = u.match(/^(stun|turn|turns):(.+)$/);
      if (m && entry.username && entry.credential) {
        out.push(m[1] + ':' + encodeURIComponent(entry.username) + ':' +
                 encodeURIComponent(entry.credential) + '@' + m[2]);
      } else {
        out.push(u);
      }
    }
  }
  return out;
}

class PairDropNode extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.targetName = opts.targetName || cfg.TARGET_NAME;
    const info = getSecret();
    this.secret = info.secret;
    log('pairing secret loaded from ' + info.source + ' (len=' + info.secret.length + ')');

    this.ws = null;
    this.rtcConfig = null;
    this.myPeerId = null;
    this.targetPeerId = null;
    this.roomType = null;
    this.roomId = null;
    this.pc = null;
    this.dc = null;
    this.remoteDescSet = false;
    this.pendingCandidates = [];
    this.remoteDisplayName = null;

    this.pendingFile = null;
    this.offset = 0;
    this.partitionBytes = 0;
    this.state = 'idle';
    this.waitingForBuffer = false;
    this.timeout = null;
    this.reconnectTimer = null;
    this.closed = false;
    this._resolve = null;
    this._reject = null;
    this.retryCount = 0;

    // Receive side. Files land in cfg.INBOX_DIR; every completed file is
    // emitted as 'file-received' so a resident service can hand it back once.
    this.received = [];
    this.receiver = new IncomingTransfer(
      m => this._sendJSON(m),
      record => {
        this.received.push(record);
        this.emit('file-received', record);
      },
      {
        onStall: name => {
          warn('incoming transfer stalled: ' + name + ' (reset to idle)');
          this.emit('receive-stalled', { name: name });
        }
      }
    );
  }

  connect() {
    if (this.closed) return;
    log('connecting signaling socket');
    const ws = new WebSocket(cfg.WS_URL, {
      headers: {
        Origin: 'https://pairdrop.net',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    });
    this.ws = ws;

    ws.on('open', () => log('signaling socket open'));
    ws.on('message', data => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_) {
        warn('malformed JSON from signaling server');
        return;
      }
      try {
        this._onWsMessage(msg);
      } catch (e) {
        error('handler error: ' + e.stack);
      }
    });
    ws.on('close', (code, reason) => {
      log('signaling closed ' + code + ' ' + (reason || ''));
      if (!this.closed) this._scheduleReconnect();
    });
    ws.on('error', e => error('socket error: ' + e.message));
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    // A signaling-socket drop is also a transfer drop: arm the auto-resend.
    this._resetPeer(true);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
    log('will reconnect in 3s');
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _onWsMessage(msg) {
    switch (msg.type) {
      case 'ws-config':
        this.rtcConfig = msg.wsConfig && msg.wsConfig.rtcConfig;
        this.wsFallback = !!(msg.wsConfig && msg.wsConfig.wsFallback);
        log('ws-config received: ' + toIceServers(this.rtcConfig).length +
            ' ICE servers, wsFallback=' + this.wsFallback);
        break;

      case 'display-name':
        this.myPeerId = msg.peerId;
        // The signaling server derives deviceName from our User-Agent. All
        // instances of this node share the same UA, so this value lets us
        // recognise (and ignore) other copies of ourselves in the same room.
        this.myDeviceName = msg.deviceName || null;
        // Same order as the browser client: join ip room, then announce pair secrets.
        this._send({ type: 'join-ip-room' });
        this._send({ type: 'room-secrets', roomSecrets: [this.secret] });
        log('joined as ' + msg.displayName + ' (' + this.myPeerId + ') device=' + this.myDeviceName);
        break;

      case 'ping':
        this._send({ type: 'pong' });
        break;

      case 'peers':
        (msg.peers || []).forEach(p => this._onPeerFound(p, msg.roomType, msg.roomId, true));
        break;

      case 'peer-joined':
        this._onPeerFound(msg.peer, msg.roomType, msg.roomId, false);
        break;

      case 'peer-left':
        log('peer left: ' + msg.peerId + ' room=' + msg.roomType);
        if (msg.peerId === this.targetPeerId) {
          this.emit('peer-offline');
          this._resetPeer(true);
        }
        break;

      case 'signal':
        this._onSignal(msg);
        break;

      case 'pair-device-join-key-invalid':
      case 'join-key-rate-limit':
      case 'secret-room-deleted':
        warn('server notice: ' + msg.type);
        break;

      default:
        break;
    }
  }

  _onPeerFound(info, roomType, roomId, isCaller) {
    if (!info || !info.id) return;
    const name = (info.name && info.name.displayName) || '';

    // Several MCP client windows can each start their own copy of this node.
    // They all share one pair secret and would otherwise treat EACH OTHER as
    // the phone: one sends, the other auto-accepts, and the tool reports a
    // false "success" while the real phone receives nothing. Same UA -> same
    // deviceName, so this reliably identifies another copy of ourselves.
    if (this.myDeviceName && info.name &&
        info.name.deviceName === this.myDeviceName) {
      log('ignoring another node instance ' + name + ' (' + info.id + ')');
      return;
    }

    const matches = !!this.targetName && name === this.targetName;
    // peers/peer-joined carry the SERVER-generated random display name. A
    // custom name only arrives later via display-name-changed over DataChannel,
    // so name matching here is unreliable. The secret room only contains
    // devices holding the same pair secret, which is a stronger identity check.
    const acceptable = matches || (roomType === 'secret' && !this.targetPeerId);
    if (!acceptable) {
      log('ignoring peer ' + name + ' (' + info.id + ') in ' + roomType);
      return;
    }
    if (!matches) {
      log('using paired peer ' + name + ' from secret room (custom name arrives over DataChannel)');
    }

    if (this.targetPeerId === info.id) {
      // The browser client joins the ip room first, so it signals over 'ip'
      // whenever both peers share an IP. Match that choice or our SDP would
      // be relayed into a room the phone is not listening on.
      if (roomType === 'ip' && this.roomType !== 'ip') {
        log('switching signaling room to ip (same network)');
        this.roomType = 'ip';
        this.roomId = 'ip';
      }
      return;
    }
    if (this.targetPeerId) return;

    this.targetPeerId = info.id;
    // For ip rooms the server derives the room key from the sender IP and ignores roomId.
    this.roomType = roomType;
    this.roomId = roomType === 'ip' ? 'ip' : roomId;
    log('TARGET ONLINE: ' + name + ' (' + info.id + ') room=' + roomType +
        ' caller=' + isCaller + ' rtcSupported=' + info.rtcSupported);
    this.emit('peer-online', { name: name, id: info.id });

    if (!this.pc) {
      this._createPeerConnection(isCaller);
    }
  }

  _createPeerConnection(isCaller) {
    const iceServers = toIceServers(this.rtcConfig);
    log('creating PeerConnection with ' + iceServers.length + ' ICE entries, caller=' + isCaller);
    const pc = new PeerConnection('pairdrop-node', {
      iceServers: iceServers,
      maxMessageSize: 262144
    });
    this.pc = pc;
    this.remoteDescSet = false;
    this.pendingCandidates = [];

    pc.onLocalDescription((sdp, type) => {
      const t = String(type).toLowerCase();
      log('local SDP ' + t);
      this._send({
        type: 'signal',
        to: this.targetPeerId,
        roomType: this.roomType,
        roomId: this.roomId,
        sdp: { type: t, sdp: sdp }
      });
    });

    pc.onLocalCandidate((candidate, mid) => {
      this._send({
        type: 'signal',
        to: this.targetPeerId,
        roomType: this.roomType,
        roomId: this.roomId,
        ice: { candidate: candidate, sdpMid: mid || '0' }
      });
    });

    pc.onStateChange(s => log('pc state: ' + s));
    pc.onGatheringStateChange(s => log('ice gathering: ' + s));

    if (isCaller) {
      this.dc = pc.createDataChannel(cfg.DC_LABEL);
      this._bindChannel(this.dc);
    } else {
      pc.onDataChannel(dc => {
        log('remote DataChannel opened: ' + dc.getLabel());
        this.dc = dc;
        this._bindChannel(dc);
      });
    }
  }

  _onSignal(msg) {
    if (!this.targetPeerId) return;
    const senderId = msg.sender && msg.sender.id;
    if (senderId && senderId !== this.targetPeerId) return;
    if (!this.pc) this._createPeerConnection(false);

    if (msg.sdp) {
      const t = msg.sdp.type === 'offer' ? 'Offer'
              : msg.sdp.type === 'answer' ? 'Answer' : 'Unspec';
      try {
        this.pc.setRemoteDescription(msg.sdp.sdp, t);
        this.remoteDescSet = true;
        this._flushCandidates();
        log('remote SDP ' + msg.sdp.type + ' applied');
      } catch (e) {
        error('setRemoteDescription failed: ' + e.message);
      }
    } else if (msg.ice && msg.ice.candidate) {
      const item = { candidate: msg.ice.candidate, mid: msg.ice.sdpMid || '0' };
      if (this.remoteDescSet) this._addCandidate(item);
      else this.pendingCandidates.push(item);
    }
  }

  _flushCandidates() {
    const list = this.pendingCandidates;
    this.pendingCandidates = [];
    list.forEach(c => this._addCandidate(c));
  }

  _addCandidate(item) {
    try {
      this.pc.addRemoteCandidate(item.candidate, item.mid);
    } catch (e) {
      warn('addRemoteCandidate failed: ' + e.message);
    }
  }

  _bindChannel(dc) {
    dc.setBufferedAmountLowThreshold(512 * 1024);
    dc.onOpen(() => {
      log('DataChannel OPEN');
      // The browser client sends display-name-changed as soon as the channel
      // opens (PeersManager._onPeerConnected). Do the same so the phone shows
      // our custom name instead of the server's random one.
      this._sendJSON({ type: 'display-name-changed', displayName: cfg.DISPLAY_NAME });
      log('announced display name: ' + cfg.DISPLAY_NAME);
      this.emit('ready');
      if (this.pendingFile && this.state === 'waiting-peer') this._startRequest();
    });
    dc.onMessage(msg => {
      if (typeof msg !== 'string') {
        this.receiver.onChunk(msg);
        return;
      }
      this._onDcMessage(msg);
    });
    dc.onClosed(() => {
      log('DataChannel closed');
      this.emit('channel-closed');
    });
    dc.onError(e => error('DataChannel error: ' + e));
    dc.onBufferedAmountLow(() => {
      if (this.waitingForBuffer) {
        this.waitingForBuffer = false;
        this._readChunk();
      }
    });
  }

  sendFile(filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
      return Promise.reject(new Error('file not found: ' + abs));
    }
    if (this._resolve) {
      return Promise.reject(new Error('another transfer is already in progress'));
    }
    if (this.receiver.busy) {
      return Promise.reject(new Error('receiving in progress; cannot send at the same time'));
    }
    const buffer = fs.readFileSync(abs);
    const name = path.basename(abs);
    this.pendingFile = { name: name, mime: mimeOf(name), size: buffer.length, buffer: buffer };
    this.retryCount = 0;
    this.offset = 0;
    this.partitionBytes = 0;
    this.state = 'waiting-peer';
    log('QUEUED ' + name + ' (' + buffer.length + ' bytes, ' + this.pendingFile.mime + ')');
    this._armTimeout(cfg.PEER_WAIT_MS, 'wait-for-peer timeout');

    const promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    if (this.dc && this.dc.isOpen()) this._startRequest();
    return promise;
  }

  _armTimeout(ms, label) {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this._fail(label), ms);
  }

  _startRequest() {
    if (this.state !== 'waiting-peer') return;
    const f = this.pendingFile;
    this.state = 'waiting-response';
    this._sendJSON({
      type: 'request',
      header: [{ name: f.name, mime: f.mime, size: f.size }],
      totalSize: f.size,
      imagesOnly: f.mime.indexOf('image/') === 0,
      thumbnailDataUrl: ''
    });
    log('request sent, waiting for files-transfer-response');
    // The peer is already connected. If it does not answer shortly, fail fast
    // instead of hanging for the full 10-minute "wait for device" window.
    this._armTimeout(60000, 'no response from peer');
  }

  _sendJSON(obj) {
    if (!this.dc || !this.dc.isOpen()) {
      // A receive-side ACK can arrive before we own a channel in unit tests;
      // do not turn that into a send failure.
      return false;
    }
    return this.dc.sendMessage(JSON.stringify(obj));
  }

  _onDcMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (_) {
      return;
    }
    switch (m.type) {
      case 'files-transfer-response':
        if (!m.accepted) {
          this._fail('transfer rejected' + (m.reason ? ': ' + m.reason : ''));
          return;
        }
        log('transfer ACCEPTED (auto-accept works)');
        this._startSending();
        break;
      case 'partition-received':
        // A partition ACK is real progress; keep the stall watchdog alive.
        this._refreshTransferTimeout();
        this._sendNextPartition();
        break;
      case 'progress':
        // The receiver reports progress while consuming chunks. Any of these
        // messages proves the transfer is alive, regardless of file size.
        this._refreshTransferTimeout();
        break;
      case 'display-name-changed':
        // This is where the phone's REAL custom name finally arrives.
        if (m.displayName) {
          this.remoteDisplayName = m.displayName;
          log('peer custom display name: ' + m.displayName);
          this.emit('peer-name', m.displayName);
        }
        break;
      case 'file-transfer-complete':
        // When WE are the sender this confirms delivery. When we are the
        // receiver we emit that message ourselves, so state stays idle.
        if (this.state === 'sending') this._succeed();
        break;

      // ---- receive side ----
      case 'request':
      case 'header':
      case 'partition':
      case 'text':
        if (m.type === 'request' &&
            (this.state === 'sending' || this.state === 'waiting-response')) {
          log('rejecting incoming request: sending in progress');
          this._sendJSON({ type: 'files-transfer-response', accepted: false });
          break;
        }
        this.receiver.onMessage(m);
        break;

      default:
        break;
    }
  }

  _startSending() {
    const f = this.pendingFile;
    this.state = 'sending';
    this.offset = 0;
    this.transferDeadline = Date.now() + cfg.TRANSFER_TIMEOUT_MS;
    this._sendJSON({ type: 'header', size: f.size, name: f.name, mime: f.mime });
    this._sendNextPartition();
    this._refreshTransferTimeout();
  }

  // A fixed "5 minute transfer timeout" wrongly kills large files on a slow
  // TURN relay (~45 KB/s means 5 min only covers ~13 MB). Instead fail only
  // when NOTHING has progressed for TRANSFER_STALL_MS; TRANSFER_TIMEOUT_MS
  // stays as an absolute cap so a slow-but-moving transfer can never hang.
  _refreshTransferTimeout() {
    if (this.state !== 'sending') return;
    const remaining = this.transferDeadline - Date.now();
    if (remaining <= 0) {
      this._fail('transfer timeout');
      return;
    }
    this._armTimeout(Math.min(cfg.TRANSFER_STALL_MS, remaining), 'transfer stalled');
  }

  _sendNextPartition() {
    if (this.state !== 'sending') return;
    this.partitionBytes = 0;
    this._readChunk();
  }

  _readChunk() {
    if (this.state !== 'sending') return;
    const f = this.pendingFile;
    if (this.offset >= f.size) return;

    if (this.dc.bufferedAmount && this.dc.bufferedAmount() > 4 * 1024 * 1024) {
      this.waitingForBuffer = true;
      return;
    }

    const end = Math.min(this.offset + cfg.CHUNK_SIZE, f.size);
    const chunk = Buffer.from(f.buffer.subarray(this.offset, end));
    this.offset += chunk.length;
    this.partitionBytes += chunk.length;

    const ok = this.dc.sendMessageBinary(chunk);
    if (!ok) {
      this._fail('sendMessageBinary returned false at offset ' + this.offset);
      return;
    }

    // Mirrors FileChunker._onChunkRead: file end first, then partition boundary.
    if (this.offset >= f.size) {
      log('all ' + f.size + ' bytes dispatched; waiting for file-transfer-complete');
      this._refreshTransferTimeout();
      return;
    }
    if (this.partitionBytes >= cfg.PARTITION_SIZE) {
      this._sendJSON({ type: 'partition', offset: this.offset });
      this._refreshTransferTimeout();
      return; // stop and wait for partition-received
    }
    setImmediate(() => this._readChunk());
  }

  _succeed() {
    if (this.state === 'done') return;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.state = 'done';
    const result = { ok: true, file: this.pendingFile.name, bytes: this.pendingFile.size };
    log('TRANSFER COMPLETE ' + JSON.stringify(result));
    this.emit('done', result);
    if (this._resolve) this._resolve(result);
    this._resolve = null;
    this._reject = null;
  }

  _fail(reason) {
    if (this.state === 'failed' || this.state === 'done' || !this._reject) return;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.state = 'failed';
    const result = { ok: false, error: reason, state: this.state };
    error('TRANSFER FAILED ' + JSON.stringify(result));
    this.emit('failed', result);
    this._reject(new Error(reason));
    this._reject = null;
    this._resolve = null;
  }

  _resetPeer(failCurrent) {
    try { if (this.dc) this.dc.close(); } catch (_) {}
    try { if (this.pc) this.pc.close(); } catch (_) {}
    this.receiver.abort();
    this.dc = null;
    this.pc = null;
    this.targetPeerId = null;
    this.remoteDescSet = false;
    this.pendingCandidates = [];
    this.waitingForBuffer = false;
    if (failCurrent &&
        (this.state === 'sending' || this.state === 'waiting-response')) {
      this._handleTransferDrop();
    }
  }

  // The wire protocol has no resume, so a reconnect resends the whole file.
  // The caller's Promise stays pending until success / exhaustion / timeout,
  // so no polling is needed while waiting for the phone to come back.
  _handleTransferDrop() {
    if (!this.pendingFile || !this._reject) return;
    if (this.retryCount >= cfg.MAX_SEND_RETRIES) {
      this._fail('peer disconnected during transfer (retries exhausted)');
      return;
    }
    this.retryCount++;
    this.state = 'waiting-peer';
    this.offset = 0;
    this.partitionBytes = 0;
    this._armTimeout(cfg.RETRY_WAIT_MS, 'reconnect timeout');
    log('transfer interrupted; auto-resend armed (attempt ' + this.retryCount +
        '/' + cfg.MAX_SEND_RETRIES + ')');
    this.emit('retry-scheduled', {
      attempt: this.retryCount,
      file: this.pendingFile.name
    });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.timeout) clearTimeout(this.timeout);
    this._resetPeer(false);
    try { if (this.ws) this.ws.close(); } catch (_) {}
  }
}

module.exports = { PairDropNode, toIceServers, mimeOf };
