'use strict';

// MCP stdio server (zero extra dependencies).
// Implements the JSON-RPC 2.0 / newline-delimited subset MCP clients use:
//   initialize, notifications/initialized, tools/list, tools/call, ping
// stdout is reserved EXCLUSIVELY for protocol messages - all logs go to stderr.
//
// Register in the client's MCP config:
//   { "command": "node", "args": ["<abs path>/mcp-server.js"] }

console.log = (...a) => process.stderr.write('[log] ' + a.join(' ') + '\n');
console.error = (...a) => process.stderr.write('[err] ' + a.join(' ') + '\n');

const readline = require('readline');
const fs = require('fs');
const bootstrap = require('./bootstrap');
const cfg = require('./config');

const SERVER_INFO = { name: 'pairdrop-mcp', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const TOOLS = [
  {
    name: 'pairdrop_setup',
    description: '首次使用或检查初始化。传入手机端 PairDrop「配对设备」显示的 6 位码即可全自动完成配置与配对；不传则由本程序生成 6 位码，需要你在手机上输入。可用 displayName 自定义本电脑在手机上显示的名字。除 6 位码外无需任何手动操作。',
    inputSchema: {
      type: 'object',
      properties: {
        pairCode: { type: 'string', description: '手机端显示的 6 位配对码（推荐）' },
        displayName: { type: 'string', description: '本机在手机上显示的自定义名字，例如「书房电脑」' }
      }
    }
  },
  {
    name: 'send_file',
    description: '把本机一个文件发送到已配对的手机。会自动等待设备上线，完成后立即返回结果，不需要轮询或截图。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '本机文件的绝对路径' } },
      required: ['path']
    }
  },
  {
    name: 'receive_file',
    description: '等待手机端发来一个文件，自动接收并保存到 inbox，返回文件信息。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'pairdrop_status',
    description: '查看配置、配对状态与当前连接状态。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'pairdrop_inbox',
    description: '列出本次运行已接收的文件。',
    inputSchema: { type: 'object', properties: {} }
  }
];

let node = null;
let readyPromise = null;
let pairingPromise = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function notify(text) {
  send({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: text }
  });
  process.stderr.write('[pairdrop] ' + text + '\n');
}

function getReady() {
  if (!readyPromise) readyPromise = bootstrap.ensureReady();
  return readyPromise;
}

// Start pairing without blocking the tool response: the code is returned
// immediately, and the phone's confirmation is collected in the background.
function startBackgroundPairing() {
  let resolveCode;
  const codePromise = new Promise(resolve => { resolveCode = resolve; });
  pairingPromise = bootstrap.runPairing({
    onCode: c => resolveCode(c)
  }).then(
    result => ({ ok: true, result: result }),
    err => ({ ok: false, error: err.message })
  );
  return codePromise;
}

async function ensureNode() {
  await getReady();
  if (pairingPromise) {
    const outcome = await pairingPromise;
    pairingPromise = null;
    if (!outcome.ok) throw new Error('配对失败：' + outcome.error);
  }
  if (!fs.existsSync(cfg.SECRET_FILE)) return null;
  if (!node) {
    const { PairDropNode } = require('./client');
    node = new PairDropNode();
    node.connect();
  }
  return node;
}

async function setupTool(args) {
  // Apply a custom name before any node is created; existing local.json keys
  // (port / inbox) are preserved and the in-process config is updated too.
  if (args.displayName) {
    await bootstrap.ensureLocalConfig({ displayName: args.displayName });
  }
  const ready = await getReady();
  ready.displayName = cfg.DISPLAY_NAME;

  if (args.pairCode) {
    // A fresh phone-generated code supersedes any pending node-generated one.
    // Do NOT await the old background pairing (it would hang until timeout).
    pairingPromise = null;
  } else if (pairingPromise) {
    const outcome = await pairingPromise;
    pairingPromise = null;
    if (!outcome.ok) return { ok: false, error: outcome.error, config: ready };
  }

  if (fs.existsSync(cfg.SECRET_FILE)) {
    const check = await bootstrap.selfCheck(2500);
    return { ok: true, ready: true, alreadyPaired: true, config: ready, check: check };
  }

  if (args.pairCode) {
    const result = await bootstrap.runPairing({ code: String(args.pairCode).trim() });
    const check = await bootstrap.selfCheck(2500);
    return { ok: true, ready: true, mode: result.mode, config: ready, check: check };
  }

  const code = await startBackgroundPairing();
  notify('PairDrop 配对码：' + code + '，请在手机点「配对设备」输入');
  return {
    ok: true,
    ready: false,
    pairCode: code,
    message: '请在手机 PairDrop 点「配对设备」输入 6 位码 ' + code +
             '。输入后直接调用 send_file / receive_file 即可，程序会自动完成配对并继续。',
    config: ready
  };
}

async function sendTool(args) {
  if (!args.path) throw new Error('path is required');
  const n = await ensureNode();
  if (!n) {
    return { ok: false, error: '尚未配对：请先调用 pairdrop_setup（可传手机端 6 位码）' };
  }
  return await n.sendFile(args.path);
}

async function receiveTool() {
  const n = await ensureNode();
  if (!n) {
    return { ok: false, error: '尚未配对：请先调用 pairdrop_setup（可传手机端 6 位码）' };
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      n.removeListener('file-received', onFile);
      resolve({ ok: false, error: 'receive wait timeout' });
    }, cfg.WAIT_TIMEOUT_MS);
    function onFile(record) {
      clearTimeout(timer);
      n.removeListener('file-received', onFile);
      resolve({ ok: true, file: record });
    }
    n.on('file-received', onFile);
  });
}

async function statusTool() {
  const ready = await getReady();
  return {
    ok: true,
    paired: fs.existsSync(cfg.SECRET_FILE),
    displayName: cfg.DISPLAY_NAME,
    port: cfg.CONTROL_PORT,
    inbox: cfg.INBOX_DIR,
    online: node ? !!node.targetPeerId : false,
    channelOpen: node ? !!(node.dc && node.dc.isOpen()) : false,
    receivedCount: node ? node.received.length : 0,
    setup: ready.steps
  };
}

async function inboxTool() {
  if (node && node.received.length) {
    return { ok: true, count: node.received.length, files: node.received };
  }
  try {
    const data = JSON.parse(fs.readFileSync(cfg.RECEIVED_FILE, 'utf8'));
    return { ok: true, count: data.length, files: data };
  } catch (_) {
    return { ok: true, count: 0, files: [] };
  }
}

async function handle(msg) {
  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params && msg.params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : '2024-11-05',
        capabilities: { tools: {}, logging: {} },
        serverInfo: SERVER_INFO,
        instructions: '首次使用先调用 pairdrop_setup（推荐传入手机端 6 位配对码）。之后用 send_file / receive_file。禁止轮询或截图判断状态：每个工具都会在完成时直接返回结果。'
      };
    }
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      try {
        let result;
        switch (name) {
          case 'pairdrop_setup': result = await setupTool(args); break;
          case 'send_file': result = await sendTool(args); break;
          case 'receive_file': result = await receiveTool(); break;
          case 'pairdrop_status': result = await statusTool(); break;
          case 'pairdrop_inbox': result = await inboxTool(); break;
          default: throw new Error('unknown tool: ' + name);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }],
          isError: true
        };
      }
    }
    case 'ping':
      return {};
    default:
      throw new Error('unknown method: ' + msg.method);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  // Notifications (including notifications/initialized) carry no id: no reply.
  if (msg.id === undefined || msg.id === null) return;
  handle(msg).then(
    result => send({ jsonrpc: '2.0', id: msg.id, result: result }),
    err => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } })
  );
});

// Warm up auto-configuration without blocking the initialize handshake.
getReady().catch(e => {
  process.stderr.write('[pairdrop] auto setup failed: ' + e.message + '\n');
});

function shutdown() {
  if (node) {
    try { node.close(); } catch (_) {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
rl.on('close', shutdown);
