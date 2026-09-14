import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { configSchema } from '../schema.js'

/**
 * zen 回流 Wave 1 — config `tools.zen` 的 schema 契约。
 *
 * 为什么单测子 schema 而不是整个 config：整 config 需要 provider 等必填 fixture，
 * 而本契约只关心 tools 段的解析行为（保留 / strict / 边界）。经探针确认
 * `configSchema.shape.tools` 可直接解析。
 *
 * RED 靶心：改动前 zen 被 zod 静默 strip（parse({zen:{...}}) → data:{}），
 * 于是 resolveZenConfig 的 fail-loud 校验永远不会被触发（死代码）。
 */
const toolsSchema = (configSchema as unknown as {
  shape: { tools: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }
}).shape.tools

const parse = (v: unknown) => toolsSchema.safeParse(v)
const zenOf = (v: unknown) => (parse(v).data as { zen?: unknown } | undefined)?.zen

describe('config tools.zen — schema 契约（zen 回流 Wave 1）', () => {
  it('未配置 zen → undefined（默认关，零行为面）', () => {
    const r = parse({})
    assert.equal(r.success, true)
    assert.equal(zenOf({}), undefined)
  })

  it('enabled=true 原样保留（不被 zod strip）', () => {
    const r = parse({ zen: { enabled: true } })
    assert.equal(r.success, true, 'zen 必须是已声明键，否则被静默 strip')
    assert.deepEqual(zenOf({ zen: { enabled: true } }), { enabled: true })
  })

  it('六键全收：enabled / face / faceMode / timeoutSteps / triage / appendixLean', () => {
    const zen = {
      enabled: true,
      face: ['read_file', 'grep'],
      faceMode: 'structuredRead',
      timeoutSteps: 3,
      triage: { enabled: false, maxChars: 40 },
      appendixLean: false,
    }
    assert.equal(parse({ zen }).success, true)
    assert.deepEqual(zenOf({ zen }), zen)
  })

  it('zen 未知键 → 解析失败（strict；否则 resolveZenConfig 的未知键检查是死代码）', () => {
    assert.equal(parse({ zen: { appendixlean: true } }).success, false)
    assert.equal(parse({ zen: { face_mode: 'minimal' } }).success, false)
  })

  it('triage 未知键 / maxChars 非正 → 解析失败', () => {
    assert.equal(parse({ zen: { triage: { maxchars: 40 } } }).success, false)
    assert.equal(parse({ zen: { triage: { maxChars: 0 } } }).success, false)
    assert.equal(parse({ zen: { triage: { maxChars: -1 } } }).success, false)
  })

  it('类型边界：enabled 非布尔 / timeoutSteps 负数 / faceMode 非法枚举 → 解析失败', () => {
    assert.equal(parse({ zen: { enabled: 'yes' } }).success, false)
    assert.equal(parse({ zen: { timeoutSteps: -1 } }).success, false)
    assert.equal(parse({ zen: { faceMode: 'full' } }).success, false)
  })

  it('preset 行为不受 zen 影响（回归守卫）', () => {
    assert.deepEqual(zenOf({ preset: 'minimal' }), undefined)
    assert.deepEqual(zenOf({ preset: 'taiyi', zen: { enabled: false } }), { enabled: false })
  })
})
