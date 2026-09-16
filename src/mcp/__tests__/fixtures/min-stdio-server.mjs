#!/usr/bin/env node
/**
 * 测试夹具：最小 MCP stdio server（换行分隔的 JSON-RPC）。
 *
 * 用途：issue #148 的重连测试需要一个**能被 SIGKILL 且能被重新拉起**的 stdio
 * 子进程。不用真实生态包——`npx -y <pkg>` 首次要拉十几秒且依赖网络，会让这条
 * 测试既慢又脆。这里只实现 `initialize` 与 `tools/list` 两个方法，够
 * createTransport 走完 connect + discover 即可。
 *
 * 刻意不处理 `notifications/initialized` 之类的通知（无 id 的消息直接跳过）：
 * 夹具要小到能一眼看完，它的可信度来自「一看就懂」而不是覆盖率。
 */
let buf = ''
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

function handle(msg) {
  const { id, method } = msg
  // JSON-RPC 通知（无 id）不需要响应。
  if (id === undefined) return
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'min-stdio-fixture', version: '0.0.1' },
        },
      })
      break
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'ping',
              description: 'fixture tool — exists so the tool face is non-empty',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      })
      break
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      break
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
  }
})

// 父进程（sidecar）没了就跟着退，避免测试跑完留下孤儿进程。
process.stdin.on('end', () => process.exit(0))
