'use strict';

// WebRTC-only self test: fetch the live ICE config, build a PeerConnection,
// confirm it can produce an offer, gather candidates and support 64000-byte messages.
const WebSocket = require('ws');
const { PeerConnection } = require('node-datachannel');
const cfg = require('./config');
const { toIceServers } = require('./client');

const ws = new WebSocket(cfg.WS_URL, {
  headers: {
    Origin: 'https://pairdrop.net',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  }
});

let started = false;
const result = { iceUrls: 0, sdp: null, candidates: 0, maxMessageSize: null, error: null };

ws.on('message', data => {
  let m;
  try { m = JSON.parse(data.toString()); } catch (_) { return; }
  if (m.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (m.type !== 'ws-config' || started) return;
  started = true;

  const ice = toIceServers(m.wsConfig.rtcConfig);
  result.iceUrls = ice.length;
  console.log('converted ICE urls (credentials masked):');
  ice.forEach(u => console.log('  ' + u.replace(/:([^:@]+):([^@]+)@/, ':***:***@')));

  let pc = null;
  let dc = null;
  try {
    pc = new PeerConnection('selftest', { iceServers: ice, maxMessageSize: 262144 });
    pc.onLocalDescription((sdp, type) => {
      result.sdp = type + ' len=' + sdp.length;
      console.log('local SDP: ' + result.sdp);
    });
    pc.onLocalCandidate((candidate, mid) => {
      result.candidates++;
      if (result.candidates <= 4) {
        console.log('candidate #' + result.candidates + ' mid=' + mid);
      }
    });
    pc.onStateChange(s => console.log('pc state: ' + s));
    dc = pc.createDataChannel(cfg.DC_LABEL);
    result.maxMessageSize = dc.maxMessageSize();
    console.log('maxMessageSize=' + result.maxMessageSize + ' (64000-byte chunks need this to be larger)');
  } catch (e) {
    result.error = e.message;
    console.error('PeerConnection FAILED: ' + e.message);
  }

  setTimeout(() => {
    console.log('\nSELFTEST RESULT\n' + JSON.stringify(result, null, 2));
    try { if (pc) pc.close(); } catch (_) {}
    try { ws.close(); } catch (_) {}
    process.exit(result.error || !result.sdp ? 1 : 0);
  }, 7000);
});

ws.on('error', e => {
  console.error('WS error: ' + e.message);
  process.exit(1);
});

setTimeout(() => {
  if (!started) {
    console.error('no ws-config received within 12s');
    process.exit(1);
  }
}, 12000);
