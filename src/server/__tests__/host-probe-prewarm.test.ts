/**
 * 桌面性能阶段 3（2026-09-13）——宿主探针异步预热与同步路径的等价性。
 *
 * 真 IO：Windows 上跑 reg.exe（两个 hive）与 `where`；Unix 上仅在 PATH 看起来
 * 残缺时 dump 登录 shell（与同步路径同条件）。预热必须与同步首算逐字等价——
 * 它替代的是 `GET /environment` 首次调用时卡主线程的 spawnSync。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getResolvedEnv,
  isResolvedEnvWarm,
  prewarmResolvedEnv,
  resetResolvedEnvCache,
} from '../../tools/resolved-env.js'
import {
  __resetShellProbeCacheForTests,
  applyConfiguredGitBashPath,
  findGitBashPath,
  getShellCommand,
  isShellProbeWarm,
  prewarmShellProbes,
} from '../../platform.js'

const pathKeyOf = (env: NodeJS.ProcessEnv) => Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'

test('prewarmResolvedEnv：落定后缓存就位，且与同步首算的 PATH / 工具链变量逐字相同', async () => {
  resetResolvedEnvCache()
  assert.equal(isResolvedEnvWarm(), false)
  await prewarmResolvedEnv()
  assert.equal(isResolvedEnvWarm(), true, '预热后缓存应就位')
  const warmed = getResolvedEnv()

  resetResolvedEnvCache()
  const sync = getResolvedEnv() // 同步路径（spawnSync）首算
  assert.equal(warmed[pathKeyOf(warmed)], sync[pathKeyOf(sync)], 'PATH 必须逐字相同')
  for (const k of ['JAVA_HOME', 'MAVEN_HOME', 'GRADLE_HOME', 'GOROOT', 'CARGO_HOME', 'PNPM_HOME']) {
    assert.equal(warmed[k], sync[k], `${k} 应一致`)
  }
  // 幂等：已缓存时再预热立即落定
  await prewarmResolvedEnv()
  assert.equal(isResolvedEnvWarm(), true)
})

test('prewarmShellProbes：落定后缓存就位，且与同步首算的 shell / Git Bash 路径相同', async () => {
  __resetShellProbeCacheForTests()
  assert.equal(isShellProbeWarm(), false)
  await prewarmShellProbes()
  assert.equal(isShellProbeWarm(), true, '预热后缓存应就位')
  const warmShell = getShellCommand()
  const warmBash = findGitBashPath()

  __resetShellProbeCacheForTests()
  const syncBash = findGitBashPath()
  const syncShell = getShellCommand()
  assert.equal(warmBash, syncBash)
  assert.deepEqual(warmShell, syncShell)
  await prewarmShellProbes()
  assert.equal(isShellProbeWarm(), true)
})

test('prewarmShellProbes：在飞期间 applyConfiguredGitBashPath 清缓存 → 旧 env 算出的结果作废', async () => {
  const prev = process.env['RIVET_GIT_BASH_PATH']
  delete process.env['RIVET_GIT_BASH_PATH']
  try {
    __resetShellProbeCacheForTests()
    const inflight = prewarmShellProbes()
    applyConfiguredGitBashPath('Z:\\definitely\\missing\\bash.exe') // 置 env + 清缓存 + 代数自增
    await inflight
    assert.equal(isShellProbeWarm(), false, '代数不符的预热结果不得写回')
    // 之后的同步/异步路径都按新 env 算（override 路径不存在 → 走探针；只需不炸）
    await prewarmShellProbes()
    assert.equal(isShellProbeWarm(), true)
  } finally {
    if (prev === undefined) delete process.env['RIVET_GIT_BASH_PATH']
    else process.env['RIVET_GIT_BASH_PATH'] = prev
    __resetShellProbeCacheForTests()
    resetResolvedEnvCache()
  }
})
