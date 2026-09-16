/**
 * `/zen` —— 禅模式显式开关（on/off/status）的判定与文案边界。
 *
 * 钉住的语义：① 默认关——不执行 on 就不写配置；② on/off 写的是**配置**而非当前
 * 会话相位（工具面在会话启动期冻结，文案不许暗示即时切换）；③ 未知子命令不静默
 * 当 on 处理。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleZenCommand } from '../zen-command.js'
import type { ZenCommandView } from '../zen-command.js'
import type { ZenPhase, ZenPromoteReason } from '../../agent/zen-mode.js'

function readEnabled(home: string): unknown {
  const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
    tools?: { zen?: { enabled?: unknown } }
  }
  return raw.tools?.zen?.enabled
}

function makeView(
  phase: ZenPhase = 'full',
  promoteReason: ZenPromoteReason | null = null,
): { lines: string[]; view: ZenCommandView; out: () => string } {
  const lines: string[] = []
  return {
    lines,
    view: {
      commitStatic: (text: string) => { lines.push(text) },
      currentPhase: () => ({ phase, promoteReason }),
    },
    out: () => lines.join('\n'),
  }
}

describe('/zen 命令', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-zen-cmd-'))
    process.env.RIVET_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  beforeEach(() => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ provider: { default: 'deepseek', providers: {} } }, null, 2) + '\n',
    )
  })

  it('无参数 = status：报默认关与当前相位，且不写配置', () => {
    const { view, out } = makeView('zen')
    assert.equal(handleZenCommand([], view), true)
    assert.match(out(), /关闭（默认）/)
    assert.match(out(), /当前会话相位：zen/)
    assert.match(out(), /\/zen on/)
    assert.equal(readEnabled(home), undefined, 'status 是只读命令')
  })

  it('/zen on 写 enabled:true，并如实说明新会话生效', () => {
    const { view, out } = makeView('full')
    handleZenCommand(['on'], view)
    assert.equal(readEnabled(home), true)
    assert.match(out(), /新会话将以读专注开局/)
    assert.match(out(), /当前会话相位仍为 full/)
  })

  it('/zen off 可关回去', () => {
    handleZenCommand(['on'], makeView().view)
    assert.equal(readEnabled(home), true)
    const { view, out } = makeView('full')
    handleZenCommand(['off'], view)
    assert.equal(readEnabled(home), false)
    assert.match(out(), /全量工具面开局/)
  })

  it('status 带晋升原因', () => {
    const { view, out } = makeView('full', 'tool')
    handleZenCommand(['status'], view)
    assert.match(out(), /晋升原因：tool/)
  })

  it('未知子命令 → 用法提示，且不写配置', () => {
    const { view, out } = makeView()
    handleZenCommand(['maybe'], view)
    assert.match(out(), /用法：\/zen on \| off \| status/)
    assert.equal(readEnabled(home), undefined)
  })

  it('大小写与首尾空白容错：/zen ON 视为 on', () => {
    handleZenCommand(['  ON '], makeView().view)
    assert.equal(readEnabled(home), true)
  })
})
