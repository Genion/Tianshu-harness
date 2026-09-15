/**
 * 影子隔离不变量（源码契约测试）。
 *
 * 三条硬约束在运行时不易观察（它们表现为「什么都没发生」），因此在源码层
 * 钉死。任一条被破坏都意味着影子开始影响行为，必须在此打红：
 *   1. 零 prompt 字节：影子模块不 import prompt/请求构造，因此开关它不可能
 *      改变 buildOaiRequest 的输出（前缀缓存零风险）。
 *   2. 不投递：不触碰 advisory-bus / control-plane，建议只进台账。
 *   3. 不阻塞：loop 接线点不 await tick。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const shadowRaw = readFileSync(join(here, '..', 'shadow-critic.ts'), 'utf-8')
/** 剥离注释后再断言：文件头注释会**说明**它不碰 promptEngine，那是文档不是依赖。 */
const shadowSrc = shadowRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const loopSrc = readFileSync(join(here, '..', 'loop.ts'), 'utf-8')

describe('影子隔离不变量', () => {
  it('零 prompt 字节：不 import prompt 层、不碰请求构造', () => {
    assert.ok(!/from '[^']*prompt\//.test(shadowSrc), '影子模块不得 import prompt 层')
    assert.ok(!shadowSrc.includes('promptEngine'), '不得持有 promptEngine')
    assert.ok(!shadowSrc.includes('buildOaiRequest'), '不得参与请求构造')
  })

  it('不投递：不触碰 advisory-bus / control-plane', () => {
    assert.ok(!shadowSrc.includes('advisoryBus'), '不得 submit 到 advisory 总线')
    assert.ok(!shadowSrc.includes('advisory-bus'), '不得依赖 advisory 总线')
    assert.ok(!shadowSrc.includes('control-plane'), '不得写 control-plane 信号')
  })

  it('loop 接线：tick 存在且不被 await（不阻塞主链）', () => {
    assert.ok(loopSrc.includes('this.shadowTick.tick('), 'loop 必须在帧写入点后触发 tick')
    assert.ok(!/await\s+[^;\n]*shadowTick\.tick\(/.test(loopSrc), 'tick 不得被 await')
    assert.ok(/flush:\s*async[\s\S]{0,200}shadowTick\.pending\(\)/.test(
      readFileSync(join(here, '..', 'loop-factory.ts'), 'utf-8'),
    ), '收尾 flush 必须等 pending（不丢台账行）')
  })
})
