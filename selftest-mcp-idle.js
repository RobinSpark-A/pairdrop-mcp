'use strict';

// Verifies that an idle MCP server releases its PairDropNode WITHOUT exiting
// the stdio process (exiting would make the MCP client report "Not connected").
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: Object.assign({}, process.env, { PAIRDROP_MCP_IDLE_MS: '1200' }),
  windowsHide: true
});

let buf = '';
const pending = new Map();
child.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.id !== undefined && m.id !== null && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 12000);
    pending.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }) + '\n');
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'idle-test', version: '1.0.0' }
  });
  assert(init.result, 'initialize must succeed');
  console.log('case 1: initialize OK');

  // A failing send still creates the node, so the idle timer starts.
  const failed = await call('tools/call', {
    name: 'send_file',
    arguments: { path: 'Z:/definitely/not/exist/file.bin' }
  });
  assert(failed.result, 'send_file must return instead of hanging');
  console.log('case 2: send_file rejected without hanging OK');

  const immediate = JSON.parse((await call('tools/call', {
    name: 'pairdrop_status', arguments: {}
  })).result.content[0].text);
  assert.strictEqual(immediate.nodeActive, true, 'node must be active right after a call');
  console.log('case 3: node active immediately OK');

  await wait(2800);
  const later = JSON.parse((await call('tools/call', {
    name: 'pairdrop_status', arguments: {}
  })).result.content[0].text);
  assert.strictEqual(later.nodeActive, false, 'idle node must be released');
  console.log('case 4: idle node released OK');

  assert.strictEqual(later.ok, true, 'stdio server must stay responsive after reclaim');
  console.log('case 5: MCP client still connected after reclaim OK');

  console.log('\nMCP IDLE SELFTEST PASSED');
  child.stdin.end();
  child.kill();
  process.exit(0);
})().catch(err => {
  console.error('MCP IDLE SELFTEST FAILED: ' + err.message);
  child.kill();
  process.exit(1);
});
