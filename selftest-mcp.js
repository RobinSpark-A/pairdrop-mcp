'use strict';

// Offline MCP handshake test: spawn the stdio server, speak JSON-RPC,
// verify initialize / tools/list / tools/call / ping, and assert stdout is
// never polluted by application logs. Restores local.json afterwards.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const localFile = path.join(__dirname, 'local.json');
const hadLocal = fs.existsSync(localFile);
const backup = hadLocal ? fs.readFileSync(localFile, 'utf8') : null;

function restoreLocal() {
  try {
    if (hadLocal) fs.writeFileSync(localFile, backup);
    else if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
  } catch (_) {}
}

const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], {
  cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
});

let buffer = '';
let badLines = 0;
const pending = new Map();

child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { badLines++; continue; }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function call(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + method)), 10000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }) + '\n');
  });
}

(async () => {
  const init = await call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'selftest', version: '1.0.0' }
  });
  assert(init.result, 'initialize must return a result');
  assert(init.result.capabilities && init.result.capabilities.tools, 'tools capability');
  assert.strictEqual(init.result.protocolVersion, '2024-11-05');
  console.log('case 1: initialize OK');

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await call(2, 'tools/list', {});
  const names = list.result.tools.map(t => t.name);
  for (const need of ['pairdrop_setup', 'send_file', 'receive_file', 'pairdrop_status', 'pairdrop_inbox']) {
    assert(names.includes(need), 'missing tool ' + need);
  }
  const setupTool = list.result.tools.find(t => t.name === 'pairdrop_setup');
  assert(setupTool && setupTool.inputSchema.properties.displayName,
    'displayName parameter missing from pairdrop_setup');
  console.log('case 2: tools/list OK (' + names.length + ' tools, displayName supported)');

  const ping = await call(3, 'ping', {});
  assert(ping.result, 'ping result');
  console.log('case 3: ping OK');

  const status = await call(4, 'tools/call', { name: 'pairdrop_status', arguments: {} });
  assert(status.result && status.result.content, 'tools/call content');
  const payload = JSON.parse(status.result.content[0].text);
  assert.strictEqual(payload.ok, true);
  console.log('case 4: tools/call(pairdrop_status) OK');

  const renamed = await call(5, 'tools/call', {
    name: 'pairdrop_setup',
    arguments: { displayName: 'Selftest PC' }
  });
  const renamedPayload = JSON.parse(renamed.result.content[0].text);
  assert.strictEqual(renamedPayload.ok, true, 'setup with displayName must succeed');
  assert.strictEqual(renamedPayload.config.displayName, 'Selftest PC',
    'custom display name must be applied');
  console.log('case 5: custom displayName applied OK');

  assert.strictEqual(badLines, 0, 'stdout must contain JSON-RPC only');
  console.log('case 6: stdout protocol purity OK');

  console.log('\nMCP SELFTEST PASSED');
  child.stdin.end();
  child.kill();
  restoreLocal();
  process.exit(0);
})().catch(err => {
  console.error('MCP SELFTEST FAILED: ' + err.message);
  child.kill();
  restoreLocal();
  process.exit(1);
});
