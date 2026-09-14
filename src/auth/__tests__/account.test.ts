/**
 * 天枢账号 device flow 客户端（CLI / TUI 侧）。
 *
 * ## 为什么另写一个而不是复用 src/auth/device-flow.ts
 * `device-flow.ts` 是按 RFC 8628 通用形状解析的——读 `raw.device_code` /
 * `raw.user_code` / `raw.verification_uri`（snake_case）。而官网 EF
 * `tui-auth-create` 返回的是**驼峰**：
 *   {"deviceCode":"…","userCode":"…","expiresIn":300,"pollInterval":5,"verifyUrl":"…"}
 * 照搬那套解析会静默拿到 undefined，用户看到「登录中」永远转圈。
 * 2026-09-14 实测线上 EF 响应确认（部署后 verifyUrl 已是 tianshuharness.com/auth/device）。
 *
 * 运行：npm exec -- tsx --test src/auth/__tests__/account.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseDeviceCreate,
  parseDevicePoll,
  isTerminalPollStatus,
  accountStore,
  saveAccountToken,
} from '../account.js'

// ── 解析契约 ─────────────────────────────────────────────────────────────

test('解析官网 EF 的驼峰响应', () => {
  const r = parseDeviceCreate({
    deviceCode: 'dc-abc123',
    userCode: '483920',
    expiresIn: 300,
    pollInterval: 5,
    verifyUrl: 'https://tianshuharness.com/auth/device',
  })
  assert.equal(r.deviceCode, 'dc-abc123')
  assert.equal(r.userCode, '483920')
  assert.equal(r.expiresIn, 300)
  assert.equal(r.pollInterval, 5)
  assert.equal(r.verifyUrl, 'https://tianshuharness.com/auth/device')
})

test('缺 deviceCode 或 userCode 时抛错，不返回半成品', () => {
  assert.throws(() => parseDeviceCreate({ userCode: '483920', verifyUrl: 'x' }), /deviceCode/)
  assert.throws(() => parseDeviceCreate({ deviceCode: 'dc-1', verifyUrl: 'x' }), /userCode/)
  assert.throws(() => parseDeviceCreate({ deviceCode: 'dc-1', userCode: '1' }), /verifyUrl/)
})

test('轮询状态：pending 无 token、approved 带 token', () => {
  const pending = parseDevicePoll({ status: 'pending' })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.accessToken, undefined)

  const ok = parseDevicePoll({
    status: 'approved',
    accessToken: 'at-xyz',
    refreshToken: 'rt-xyz',
    expiresIn: 3600,
  })
  assert.equal(ok.status, 'approved')
  assert.equal(ok.accessToken, 'at-xyz')
  assert.equal(ok.refreshToken, 'rt-xyz')
  assert.equal(ok.expiresIn, 3600)
})

test('approved 但缺 accessToken 视为异常，不写入空凭据', () => {
  assert.throws(() => parseDevicePoll({ status: 'approved' }), /accessToken/)
})

test('终态判定：denied / expired / already_consumed 都要停下来', () => {
  assert.equal(isTerminalPollStatus('denied'), true)
  assert.equal(isTerminalPollStatus('expired'), true)
  assert.equal(isTerminalPollStatus('already_consumed'), true)
  assert.equal(isTerminalPollStatus('error'), true)
  assert.equal(isTerminalPollStatus('pending'), false)
  assert.equal(isTerminalPollStatus('approved'), false)
})

// ── 落盘 ─────────────────────────────────────────────────────────────────

test('账号 token 落到 <RIVET_HOME>/account.json，权限 0600', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-acct-'))
  try {
    const store = accountStore(home)
    const saved = saveAccountToken(store, {
      status: 'approved',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresIn: 3600,
    })

    assert.equal(saved.accessToken, 'at-1')
    assert.equal(saved.refreshToken, 'rt-1')
    assert.ok(saved.expiresAt > Date.now(), 'expiresAt 应是从现在起算的未来时间')

    // 文件名必须是 account.json —— 与 provider 的 <provider>.json 区分开，
    // 否则会覆盖掉同名的 provider 凭据
    const raw = readFileSync(join(home, 'account.json'), 'utf8')
    assert.equal(JSON.parse(raw).accessToken, 'at-1')

    const mode = statSync(join(home, 'account.json')).mode & 0o777
    assert.equal(mode, 0o600, `凭据文件权限应为 0600，实际 ${mode.toString(8)}`)

    // 能读回来
    assert.equal(store.load()?.accessToken, 'at-1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('saveAccountToken 拒绝没有 token 的轮询结果', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-acct-'))
  try {
    const store = accountStore(home)
    assert.throws(() => saveAccountToken(store, { status: 'pending' }), /accessToken/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
