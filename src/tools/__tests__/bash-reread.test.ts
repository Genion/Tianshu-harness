import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { checkBashReread } from '../bash.js'

describe('checkBashReread', () => {
  // Reset tracker between tests by exploiting the toolUseId dedup
  beforeEach(() => {
    // No reset needed — each test uses unique toolUseId sequences
  })

  it('does NOT warn when same file is read with different commands', () => {
    // head vs tail on the same file — different commands, no warning
    const w1 = checkBashReread("head -3 ~/.rivet/sessions/test.jsonl", 'id-1')
    assert.equal(w1, null)
    const w2 = checkBashReread("tail -20 ~/.rivet/sessions/test.jsonl", 'id-2')
    assert.equal(w2, null, 'different command on same path should not trigger reread')
  })

  it('does NOT warn when same file is read with different grep patterns', () => {
    checkBashReread("grep 'foo' /tmp/test.txt", 'id-1')
    // Different pattern on same path — no warning expected
    // (/tmp is excluded, so this won't trigger anyway — use a non-tmp path)
  })

  it('does NOT warn when same file is read with different grep patterns (real path)', () => {
    // Use a known file path in the project
    // Must prime with a unique dummy path that won't collide
    const path = '/etc/hosts'
    checkBashReread(`grep 'somepattern' ${path}`, 'id-1')
    const w2 = checkBashReread(`grep 'otherpattern' ${path}`, 'id-2')
    assert.equal(w2, null, 'different grep pattern should not trigger reread')
  })

  it('warns when identical command is repeated on same file', () => {
    checkBashReread("cat /etc/hosts", 'id-1')
    const w2 = checkBashReread("cat /etc/hosts", 'id-2')
    assert.ok(w2 !== null, 'identical command repetition should trigger warning')
    assert.ok(w2!.includes('bash-reread'))
  })

  it('does not warn for /tmp paths', () => {
    const w1 = checkBashReread("cat /tmp/foo.txt", 'id-1')
    const w2 = checkBashReread("cat /tmp/foo.txt", 'id-2')
    assert.equal(w2, null, '/tmp paths should not be tracked')
  })

  it('does not warn for /dev paths', () => {
    const w1 = checkBashReread("cat /dev/null", 'id-1')
    const w2 = checkBashReread("cat /dev/null", 'id-2')
    assert.equal(w2, null, '/dev paths should not be tracked')
  })

  it('warns for repeated grep with same pattern on same file', () => {
    checkBashReread("grep 'error' /etc/hosts", 'id-1')
    const w2 = checkBashReread("grep 'error' /etc/hosts", 'id-2')
    assert.ok(w2 !== null, 'same grep pattern on same file should trigger warning')
  })

  it('warns for repeated head with same line count on same file', () => {
    checkBashReread("head -5 /etc/hosts", 'id-1')
    const w2 = checkBashReread("head -5 /etc/hosts", 'id-2')
    assert.ok(w2 !== null, 'same head command on same file should trigger warning')
  })

  it('does not warn for head with different line counts', () => {
    checkBashReread("head -3 /etc/hosts", 'id-1')
    const w2 = checkBashReread("head -10 /etc/hosts", 'id-2')
    assert.equal(w2, null, 'head with different line count should not trigger reread')
  })

  it('does NOT warn when same file is grepped with different quoted patterns containing spaces', () => {
    checkBashReread("grep 'foo bar' /etc/hosts", 'id-1')
    const w2 = checkBashReread("grep 'foo baz' /etc/hosts", 'id-2')
    assert.equal(w2, null, 'different quoted patterns with spaces should not trigger reread')
  })

  it('warns when same quoted pattern with spaces is repeated', () => {
    checkBashReread('grep "error message" /etc/hosts', 'id-1')
    const w2 = checkBashReread('grep "error message" /etc/hosts', 'id-2')
    assert.ok(w2 !== null, 'same quoted pattern with spaces should trigger reread')
  })

  // ── 台账 F1：key 退化误报（2026-09-14）────────────────────────────
  // `cd … && npx tsx --test <不同文件> | grep -c '✔'` 这类命令：verb 识别只看
  // 行首（落 other），grep 模式的「文件路径」捕获吃进引号内统计符号（'✔'）→
  // 所有同尾巴形态的命令共享 key `other:✔` → 不同命令互相误报。
  it('不误报：不同测试文件 + 相同管道尾巴（grep -c 统计符号被当文件）', () => {
    const cmdA = `cd /work && timeout 60 npx tsx --test src/server/__tests__/session-trim-async.test.ts 2>&1 | grep -c '✔'`
    const cmdB = `cd /work && timeout 60 npx tsx --test src/server/__tests__/session-sparse-index.test.ts 2>&1 | grep -c '✔'`
    assert.equal(checkBashReread(cmdA, 'f1-1'), null)
    assert.equal(checkBashReread(cmdB, 'f1-2'), null, '不同文件的同类命令不得因尾巴相同而误报')
  })
})
