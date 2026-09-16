import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMcpError } from '../failure-classifier.js'

describe('classifyMcpError', () => {
  it('classifies ENOENT as config error', () => {
    const result = classifyMcpError(new Error('spawn server ENOENT'))
    assert.equal(result.class, 'config')
    assert.equal(result.retryable, false)
  })

  it('classifies 401 as auth error', () => {
    const result = classifyMcpError(new Error('401 Unauthorized'))
    assert.equal(result.class, 'auth')
    assert.equal(result.retryable, false)
  })

  it('classifies ECONNREFUSED as network error', () => {
    const result = classifyMcpError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))
    assert.equal(result.class, 'network')
    assert.equal(result.retryable, true)
  })

  it('classifies socket hang up as network error', () => {
    const result = classifyMcpError(new Error('socket hang up'))
    assert.equal(result.class, 'network')
    assert.equal(result.retryable, true)
  })

  it('classifies InvalidParams as protocol error', () => {
    const result = classifyMcpError(new Error('InvalidParams: missing required field'))
    assert.equal(result.class, 'protocol')
    assert.equal(result.retryable, false)
  })

  it('classifies unknown error as tool_error', () => {
    const result = classifyMcpError(new Error('Something went wrong in the tool'))
    assert.equal(result.class, 'tool_error')
    assert.equal(result.retryable, false)
  })

  it('handles non-Error input', () => {
    const result = classifyMcpError('string error')
    assert.equal(result.class, 'tool_error')
  })

  it('classifies stdio connection closed as process error (issue #72 现场形态)', () => {
    const err = new Error('MCP error -32000: Connection closed')
    const result = classifyMcpError(err, { transport: 'stdio' })
    assert.equal(result.class, 'process')
    assert.equal(result.retryable, false)
    assert.match(result.suggestion, /stderr|command/i)
  })

  it('classifies remote connection closed as network error（保留重试语义）', () => {
    const result = classifyMcpError(new Error('MCP error -32000: Connection closed'), { transport: 'remote' })
    assert.equal(result.class, 'network')
    assert.equal(result.retryable, true)
  })

  it('无 transport 上下文时 Connection closed 不判为 process（保守，落 network）', () => {
    const result = classifyMcpError(new Error('Connection closed'))
    assert.equal(result.class, 'network')
  })

  it('handles null/undefined input', () => {
    const result = classifyMcpError(null)
    assert.equal(result.class, 'tool_error')
  })
})

/**
 * issue #149：三种根因（PATH 缺失 / 包不存在 / npm 缓存损坏）都表现为同一个
 * `-32000: Connection closed`，而分类器此前只看 err.message，看不到 stderr——
 * 于是给出同一句「进程启动后立即退出」，用户拿不到任何可执行的下一步。
 *
 * 这里锁的是「stderr 特征 → 具体根因」的映射。要害在最后两条：识别不出特征时
 * 必须回落 process，不能把未知当已知——谎报根因比不报更坏。
 */
describe('classifyMcpError · stderr 细分（issue #149）', () => {
  const CLOSED = new Error('MCP error -32000: Connection closed')

  it('stderr 出现 spawn cmd ENOENT → 判为子进程环境（PATH）问题', () => {
    const result = classifyMcpError(CLOSED, {
      transport: 'stdio',
      stderr: 'npm error enoent spawn cmd ENOENT\nnpm error enoent This is related to npm not being able to find a file.',
    })
    assert.equal(result.class, 'process_env')
    assert.equal(result.retryable, false, '环境缺失不会因为重试而自愈')
    assert.match(result.suggestion, /PATH/i)
  })

  it('stderr 出现 npm 404 → 判为包获取问题，提示落在包名/registry', () => {
    const result = classifyMcpError(CLOSED, {
      transport: 'stdio',
      stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@scope%2fnope - Not found',
    })
    assert.equal(result.class, 'process_install')
    assert.equal(result.retryable, false)
    assert.match(result.suggestion, /package|registry|name/i)
  })

  it('stderr 出现 npm 缓存/解包失败 → 同归包获取问题（issue #77 的现场形态）', () => {
    const result = classifyMcpError(CLOSED, {
      transport: 'stdio',
      stderr: 'npm error code ENOTEMPTY\nnpm error syscall rename\nnpm error path /tmp/_npx/abc/node_modules/minipass',
    })
    assert.equal(result.class, 'process_install')
  })

  it('stderr 为空 → 回落 process，不猜根因', () => {
    const result = classifyMcpError(CLOSED, { transport: 'stdio', stderr: '' })
    assert.equal(result.class, 'process')
  })

  it('stderr 有内容但无特征 → 仍回落 process（不把未知当已知）', () => {
    const result = classifyMcpError(CLOSED, {
      transport: 'stdio',
      stderr: 'some unrelated log line the server printed before dying',
    })
    assert.equal(result.class, 'process')
  })

  it('remote 传输不参与 stderr 细分（那是本地子进程才有的证据）', () => {
    const result = classifyMcpError(CLOSED, {
      transport: 'remote',
      stderr: 'npm error enoent spawn cmd ENOENT',
    })
    assert.equal(result.class, 'network', 'remote 的 -32000 保持可重试语义')
    assert.equal(result.retryable, true)
  })
})
