import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  providerKeysPath,
  readProviderKeysFile,
  writeProviderKeysFile,
  providerKeysFileMode,
  PROVIDER_KEYS_FILE_VERSION,
} from '../provider-keys-store.js'

describe('provider-keys-store — 磁盘边界', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-pkstore-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })
  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('路径与 config.json 同目录，名称为 provider-keys.json', () => {
    const p = providerKeysPath()
    assert.equal(p, join(dir, 'provider-keys.json'))
    assert.equal(p.startsWith(dir), true)
  })

  it('写入后读回完整 key 池，且权限为 0600', () => {
    writeProviderKeysFile({
      version: PROVIDER_KEYS_FILE_VERSION,
      providers: {
        relay: [
          { id: 'default', keyRef: 'relay', models: [{ id: 'm1', contextWindow: 128000, maxTokens: 8192 }] },
          { id: 'second', label: '二号', keyRef: 'relay:second', models: [{ id: 'm2', contextWindow: 128000, maxTokens: 8192 }] },
        ],
      },
    })
    const back = readProviderKeysFile()
    assert.ok(back, '读回存在')
    assert.deepEqual(Object.keys(back.providers), ['relay'])
    assert.equal(back.providers.relay?.length, 2)
    assert.equal(back.providers.relay?.[1]?.label, '二号')
    assert.equal(statSync(providerKeysPath()).mode & 0o777, 0o600)
  })

  it('文件缺失时返回 undefined（fail-open，不抛）', () => {
    assert.equal(readProviderKeysFile(), undefined)
    assert.equal(providerKeysFileMode(), undefined)
  })

  it('JSON 损坏时返回 undefined，不抛异常', () => {
    writeFileSync(providerKeysPath(), '{ this is not json')
    assert.equal(readProviderKeysFile(), undefined)
  })

  it('version 不匹配时返回 undefined（拒绝误读他版形状）', () => {
    writeFileSync(providerKeysPath(), JSON.stringify({ version: 99, providers: { a: [] } }))
    assert.equal(readProviderKeysFile(), undefined)
  })

  it('单条坏 key 被丢弃，其余有效条目保留', () => {
    writeFileSync(providerKeysPath(), JSON.stringify({
      version: PROVIDER_KEYS_FILE_VERSION,
      providers: {
        relay: [
          { id: 'ok-one', models: [] },
          { noIdHere: true },
        ],
      },
    }))
    const back = readProviderKeysFile()
    assert.ok(back)
    assert.equal(back.providers.relay?.length, 1)
    assert.equal(back.providers.relay?.[0]?.id, 'ok-one')
  })

  it('写入是原子的：目录里不残留 .tmp', () => {
    writeProviderKeysFile({ version: PROVIDER_KEYS_FILE_VERSION, providers: { a: [{ id: 'k', models: [] }] } })
    const leftovers = readdirSafe(dir).filter(f => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    assert.equal(existsSync(providerKeysPath()), true)
    // 文件内容是合法 JSON（可被再次解析）
    assert.doesNotThrow(() => JSON.parse(readFileSync(providerKeysPath(), 'utf-8')))
  })
})

function readdirSafe(d: string): string[] {
  try {
    return readdirSync(d)
  } catch {
    return []
  }
}
