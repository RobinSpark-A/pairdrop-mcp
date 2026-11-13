# pairdrop-mcp

[中文](#中文文档)

A [PairDrop](https://pairdrop.net) MCP server. Lets an AI agent send files to / receive files from a paired phone over WebRTC — no browser, no cloud drive, no polling, no screenshots.

## Requirements
- Node.js 18.20+ / 20 / 22
- Access to `wss://pairdrop.net/server` and TURN (5349 / 443)
- Phone with `https://pairdrop.net/` open, screen on, page in foreground

## Install & configure

```bash
npm install
```

Add to your MCP client config (replace with YOUR absolute path):

```json
{ "mcpServers": { "pairdrop": { "command": "node", "args": ["/absolute/path/to/mcp-server.js"] } } }
```

Then trust / restart the MCP server in your client.

## First-time pairing

Only one human action is needed: a 6-digit code.

```bash
node setup.js 123456 --name "My PC"
```

Or via MCP: `pairdrop_setup {"pairCode":"123456","displayName":"My PC"}`.
If you pass no code, the program generates one for you to type on the phone.
On the phone, enable **auto accept** for this device; otherwise you must tap Accept on every send.

Dependencies, a free local port, display name, inbox folder and `secret.txt` are all created automatically.

## MCP tools

| Tool | Purpose |
|---|---|
| `pairdrop_setup` | First-run setup / pairing / status check |
| `send_file` | Send a local file to the phone; returns as soon as it finishes |
| `receive_file` | Wait for one file from the phone and save it automatically |
| `pairdrop_status` | Config, pairing and connection state |
| `pairdrop_inbox` | List received files |

## CLI (optional)

```bash
node ask.js send "/path/to/file"
node ask.js receive
node ask.js inbox
node ask.js status
```

`ask.js` starts a local daemon on demand; the daemon exits after 3 idle minutes.

## How it works

Joins a paired secret room on PairDrop's official signaling server, then transfers over a WebRTC DataChannel (64,000-byte chunks, 1 MB partition ACKs). Files are peer-to-peer and never stored on a server. TURN credentials are fetched on every connection, never hardcoded.

## Security notes

- **Never commit or share `secret.txt`** — it is a bearer credential for your pairing. `.gitignore` also excludes `local.json`, `inbox/`, logs and `node_modules/`.
- Do not copy `node_modules/` between machines (platform-specific native binaries).
- The protocol has no checksum or strong authentication; avoid highly sensitive data.

---

# 中文文档

[English](#pairdrop-mcp)

一个 [PairDrop](https://pairdrop.net) 的 MCP server：让 AI agent 通过 WebRTC 在电脑与已配对手机之间收发文件，全程不需要浏览器、云盘、轮询或截图。

## 环境要求
- Node.js 18.20+ / 20 / 22
- 能访问 `wss://pairdrop.net/server` 与 TURN（5349 / 443）
- 手机打开 `https://pairdrop.net/`，保持亮屏且页面在前台

## 安装与配置

```bash
npm install
```

在 MCP 客户端配置里加入（路径换成你自己的绝对路径）：

```json
{ "mcpServers": { "pairdrop": { "command": "node", "args": ["你自己的绝对路径/mcp-server.js"] } } }
```

然后在客户端里 Trust / 重启该 MCP server。

## 首次配对

唯一需要人工操作的是 6 位配对码：

```bash
node setup.js 123456 --name "我的电脑"
```

或调用 MCP：`pairdrop_setup {"pairCode":"123456","displayName":"我的电脑"}`。
不传码时程序会自己生成一个，由你在手机上输入。
请在手机端为这台设备开启**自动接收**，否则每次发送都要手动点「接收」。

依赖、空闲端口、显示名、收件目录和 `secret.txt` 全部自动生成，无需手改配置文件。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `pairdrop_setup` | 首次配置 / 配对 / 状态检查 |
| `send_file` | 发送本机文件到手机，完成即返回结果 |
| `receive_file` | 等待手机发来一个文件并自动保存 |
| `pairdrop_status` | 配置、配对与连接状态 |
| `pairdrop_inbox` | 已接收文件列表 |

## 命令行（可选）

```bash
node ask.js send "路径"
node ask.js receive
node ask.js inbox
node ask.js status
```

`ask.js` 会按需启动本地 daemon，daemon 空闲 3 分钟后自动退出。

## 原理

连接官方信令服务器并加入配对 secret 房间，随后通过 WebRTC DataChannel 传输（64,000 字节分片、每 1 MB 一次 partition 确认）。文件点对点传输，不经过服务器存储；TURN 凭据每次连接动态获取，不写死在代码里。

## 安全提醒

- **绝不要提交或转发 `secret.txt`**——它是配对身份的 bearer 密钥。`.gitignore` 已一并排除 `local.json`、`inbox/`、日志和 `node_modules/`。
- 不要跨机器复制 `node_modules/`（原生二进制与平台相关）。
- 协议没有校验和、也没有强身份认证，请勿用于高度敏感文件。
