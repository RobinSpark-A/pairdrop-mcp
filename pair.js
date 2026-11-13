'use strict';

// First-run pairing for a NEW machine. The official signaling server issues
// the 256-character roomSecret together with the 6-digit pair key
// (ws-server.js: _onPairDeviceInitiate), so the node can save it immediately.
// No Chrome / IndexedDB is needed on the recipient's machine.
//
//   npm run pair
//   -> prints a 6-digit code; enter it on the phone's "Pair Devices" dialog
//   -> secret.txt is written automatically, then the process exits

const fs = require('fs');
const WebSocket = require('ws');
const cfg = require('./config');
const { log } = require('./log');

const ws = new WebSocket(cfg.WS_URL, {
  headers: {
    Origin: 'https://pairdrop.net',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  }
});

let issued = false;
let joined = false;

const guard = setTimeout(() => {
  if (!joined) {
    // A half-finished pairing leaves a secret the phone never learned about.
    if (issued && fs.existsSync(cfg.SECRET_FILE)) {
      try { fs.unlinkSync(cfg.SECRET_FILE); } catch (_) {}
    }
    console.error('配对等待超时，请重新运行 npm run pair');
    log('pair timed out, partial secret removed');
  }
  try { ws.close(); } catch (_) {}
  process.exit(joined ? 0 : 1);
}, cfg.WAIT_TIMEOUT_MS);

ws.on('message', data => {
  let m;
  try { m = JSON.parse(data.toString()); } catch (_) { return; }

  switch (m.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'display-name':
      ws.send(JSON.stringify({ type: 'pair-device-initiate' }));
      break;

    case 'pair-device-initiated':
      issued = true;
      fs.writeFileSync(cfg.SECRET_FILE, m.roomSecret, 'utf8');
      console.log('\n=========================================');
      console.log('  请在手机 PairDrop 页面点「配对设备」并输入：');
      console.log('              ' + m.pairKey);
      console.log('=========================================\n');
      console.log('配对密钥已保存到 ' + cfg.SECRET_FILE);
      log('pair initiated, key=' + m.pairKey + ' secretLen=' + m.roomSecret.length);
      break;

    case 'pair-device-joined':
      joined = true;
      clearTimeout(guard);
      console.log('配对完成，手机已加入。现在可以关闭此窗口。');
      log('pair completed');
      try { ws.close(); } catch (_) {}
      process.exit(0);
      break;

    case 'pair-device-join-key-invalid':
    case 'join-key-rate-limit':
      console.error('配对失败：' + m.type + '，请重新运行 npm run pair');
      break;

    default:
      break;
  }
});

ws.on('error', e => {
  console.error('连接失败：' + e.message);
  clearTimeout(guard);
  process.exit(1);
});
