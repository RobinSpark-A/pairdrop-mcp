'use strict';

// Minimal signaling-layer probe: verifies WS connectivity, ws-config delivery,
// heartbeat and whether the reused pair secret places us in the same secret room.
const WebSocket = require('ws');
const cfg = require('./config');
const { getSecret } = require('./secret');

const info = getSecret();
console.log('secret source : ' + info.source);
console.log('secret length : ' + info.secret.length);

const ws = new WebSocket(cfg.WS_URL, {
  headers: {
    Origin: 'https://pairdrop.net',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  }
});

const report = { wsOpen: false, wsConfig: false, iceServers: 0, wsFallback: null,
                 peerId: null, joined: false, pongs: 0, peers: [], rooms: [] };

ws.on('open', () => { report.wsOpen = true; console.log('WS open'); });

ws.on('message', data => {
  let m;
  try { m = JSON.parse(data.toString()); } catch (_) { return; }
  switch (m.type) {
    case 'ws-config':
      report.wsConfig = true;
      report.iceServers = (m.wsConfig.rtcConfig.iceServers || []).length;
      report.wsFallback = m.wsConfig.wsFallback;
      console.log('ws-config: ' + report.iceServers + ' ICE entries, wsFallback=' + report.wsFallback);
      break;
    case 'display-name':
      report.peerId = m.peerId;
      ws.send(JSON.stringify({ type: 'join-ip-room' }));
      ws.send(JSON.stringify({ type: 'room-secrets', roomSecrets: [info.secret] }));
      report.joined = true;
      console.log('assigned name=' + m.displayName + ' peerId=' + m.peerId);
      console.log('sent join-ip-room + room-secrets');
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      report.pongs++;
      break;
    case 'peers':
      report.rooms.push(m.roomType);
      (m.peers || []).forEach(p => {
        const label = (p.name && p.name.displayName) + '@' + m.roomType;
        report.peers.push(label);
        console.log('peer in room: ' + label);
      });
      break;
    case 'peer-joined':
      report.peers.push((m.peer.name && m.peer.name.displayName) + '@' + m.roomType + '(joined)');
      console.log('peer joined: ' + m.peer.name.displayName + ' in ' + m.roomType);
      break;
    case 'pair-device-join-key-invalid':
    case 'join-key-rate-limit':
      console.log('SERVER REJECT: ' + m.type);
      break;
    default:
      break;
  }
});

ws.on('error', e => { console.error('WS error: ' + e.message); report.error = e.message; });

setTimeout(() => {
  console.log('\nPROBE RESULT\n' + JSON.stringify(report, null, 2));
  try { ws.close(); } catch (_) {}
  process.exit(0);
}, 9000);
