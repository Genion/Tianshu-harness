/**
 * 天枢账号登录（RFC 8628 device flow，服务端为官网 Supabase Edge Functions）。
 *
 * ## 为什么走 device flow 而不是内嵌登录窗
 * 桌面端 WebView 内嵌窗口的回调写不进 sidecar（见
 * `desktop/src/surfaces/InsightsSurface.tsx` 的历史问题与
 * `insights-login-failure-contract.test.ts` 的守卫）。浏览器授权 + 轮询是唯一在
 * CLI / TUI / 桌面三种客户端都成立的形状。
 *
 * ## 与 src/auth/device-flow.ts 的关系
 * 那个模块是 RFC 8628 的**通用**解析（snake_case：device_code / user_code /
 * verification_uri），而官网 EF 返回**驼峰**。两者不兼容——照搬会静默拿到
 * undefined（用户看到「登录中」永远转圈）。本模块按官网 EF 的真实契约解析。
 * 目前 device-flow.ts 仍是零调用方，留作将来对接标准 RFC 8628 服务端时用。
 *
 * ## 账号 token 与 license token 是两回事
 * 本模块只处理**账号**身份（Supabase session）；Pro 解锁仍由授权服的 Ed25519
 * token + Rust 验签负责（`desktop/src-tauri/src/activation.rs`）。两者分开存储：
 * `<RIVET_HOME>/account.json` vs `<RIVET_HOME>/license.json`。
 */
import { TokenStore, type TokenData } from './token-store.js'

/** 官网 Supabase 项目（Edge Functions 基址）。 */
const DEFAULT_ACCOUNT_API = 'https://grcedmhghzroqnirizcy.supabase.co'

/**
 * Supabase publishable key —— **公开密钥**。
 *
 * 需要它是因为官网 Edge Functions 开着 `verify_jwt`：不带认证头的请求直接
 * 401（2026-09-14 探针实测，当时 CLI 侧漏了这一步，单测全绿但真实调用打不通）。
 * DEPLOYMENT.md 写明这个 key「设计上随 JS 产物分发」，任何浏览器请求里都可见，
 * 因此内置于 CLI 不构成泄露。
 *
 * 指向自托管 / 测试项目时用 `RIVET_ACCOUNT_ANON_KEY` 覆盖。
 */
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_9fLEHwAUNOLZpayKfPW1-g_bbcNNoCR'

/** 单次 HTTP 调用的超时。轮询本身靠 deadline 控制，这里防的是单请求挂死。 */
const HTTP_TIMEOUT_MS = 15_000

/** Edge Function 调用所需的头（apikey 是 verify_jwt 的凭据）。 */
function accountHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: process.env.RIVET_ACCOUNT_ANON_KEY ?? DEFAULT_PUBLISHABLE_KEY,
  }
}

/**
 * 账号 API 基址。可用 `RIVET_ACCOUNT_API` 覆盖（自托管 / 指向测试项目）。
 */
export function accountApiBase(): string {
  return (process.env.RIVET_ACCOUNT_API ?? DEFAULT_ACCOUNT_API).replace(/\/+$/, '')
}

// ── 授权请求 ─────────────────────────────────────────────────────────────

export interface DeviceCreateResult {
  deviceCode: string
  userCode: string
  expiresIn: number
  pollInterval: number
  verifyUrl: string
}

/**
 * 解析 `tui-auth-create` 的响应。
 *
 * 三个字段缺一不可：deviceCode 用于轮询，userCode 要展示给用户，
 * verifyUrl 是让用户去浏览器打开的地方——缺任何一个流程都走不下去，
 * 返回半成品只会让故障点后移（表现为「转圈」而不是报错）。
 */
export function parseDeviceCreate(raw: Record<string, unknown>): DeviceCreateResult {
  const deviceCode = raw.deviceCode
  const userCode = raw.userCode
  const verifyUrl = raw.verifyUrl

  if (typeof deviceCode !== 'string' || !deviceCode) {
    throw new Error('device create: missing deviceCode')
  }
  if (typeof userCode !== 'string' || !userCode) {
    throw new Error('device create: missing userCode')
  }
  if (typeof verifyUrl !== 'string' || !verifyUrl) {
    throw new Error('device create: missing verifyUrl')
  }

  return {
    deviceCode,
    userCode,
    verifyUrl,
    expiresIn: typeof raw.expiresIn === 'number' ? raw.expiresIn : 300,
    pollInterval: typeof raw.pollInterval === 'number' ? raw.pollInterval : 5,
  }
}

export interface RequestDeviceCodeOpts {
  tuiVersion?: string
  deviceName?: string
  /** 客户端持久硬件指纹——授权页用它作为设备标识（迁移 047 起） */
  deviceFingerprint?: string
}

/** 发起一次授权请求。调用方负责把 userCode / verifyUrl 展示给用户。 */
export async function requestDeviceCode(opts: RequestDeviceCodeOpts = {}): Promise<DeviceCreateResult> {
  const res = await fetch(`${accountApiBase()}/functions/v1/tui-auth-create`, {
    method: 'POST',
    headers: accountHeaders(),
    body: JSON.stringify({
      tuiVersion: opts.tuiVersion ?? null,
      deviceName: opts.deviceName ?? null,
      deviceFingerprint: opts.deviceFingerprint ?? null,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`device create failed: ${res.status}`)
  }
  return parseDeviceCreate((await res.json()) as Record<string, unknown>)
}

// ── 轮询 ─────────────────────────────────────────────────────────────────

export type PollStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'already_consumed'
  | 'error'

export interface DevicePollResult {
  status: PollStatus
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
}

/**
 * 解析 `tui-auth-check` 的响应。
 *
 * `approved` 却没有 accessToken 视为异常而非「成功但空」——否则会把空凭据写盘，
 * 用户下次启动发现自己「已登录」但什么都做不了。
 */
export function parseDevicePoll(raw: Record<string, unknown>): DevicePollResult {
  const status = String(raw.status ?? 'error') as PollStatus

  if (status === 'approved') {
    const accessToken = raw.accessToken
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('device poll: approved without accessToken')
    }
    return {
      status,
      accessToken,
      refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
      expiresIn: typeof raw.expiresIn === 'number' ? raw.expiresIn : 3600,
    }
  }

  return { status }
}

/** 该状态是否意味着「不用再轮询了」。 */
export function isTerminalPollStatus(s: PollStatus): boolean {
  return s === 'denied' || s === 'expired' || s === 'already_consumed' || s === 'error'
}

export interface PollOpts {
  intervalSeconds?: number
  timeoutMs?: number
  /** 每次 tick 回调（用于在同一行刷新进度，避免刷屏） */
  onTick?: (elapsedMs: number) => void
}

/**
 * 轮询直到拿到 token 或进入终态。
 *
 * 404 按 `expired` 处理：码被清理说明它已过期或不存在，继续轮询只是白等。
 */
export async function pollForAccountToken(
  deviceCode: string,
  opts: PollOpts = {},
): Promise<DevicePollResult> {
  const intervalMs = (opts.intervalSeconds ?? 5) * 1000
  const totalMs = opts.timeoutMs ?? 300_000
  const deadline = Date.now() + totalMs

  while (Date.now() < deadline) {
    let res: Response
    try {
      res = await fetch(`${accountApiBase()}/functions/v1/tui-auth-check`, {
        method: 'POST',
        headers: accountHeaders(),
        body: JSON.stringify({ deviceCode }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
    } catch {
      // 单次网络抖动不该终止整轮登录——等下一个 tick 再试
      opts.onTick?.(Date.now() - (deadline - totalMs))
      await sleep(intervalMs)
      continue
    }

    if (res.status === 404) return { status: 'expired' }

    if (res.ok) {
      const parsed = parseDevicePoll((await res.json()) as Record<string, unknown>)
      if (parsed.status !== 'pending') return parsed
    }

    opts.onTick?.(Date.now() - (deadline - totalMs))
    await sleep(intervalMs)
  }

  return { status: 'expired' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── 落盘 ─────────────────────────────────────────────────────────────────

/**
 * 账号凭据存储：`<RIVET_HOME>/account.json`（权限 0600，复用 TokenStore）。
 *
 * provider 名用 'account' 而非某个模型 provider 名——避免与 provider 的
 * `<provider>.json` 撞名互相覆盖。
 */
export function accountStore(rivetHome: string): TokenStore {
  return new TokenStore(rivetHome, 'account')
}

/** 把轮询结果写盘。没有 accessToken 时抛错（不写空凭据）。 */
export function saveAccountToken(store: TokenStore, poll: DevicePollResult): TokenData {
  if (!poll.accessToken) {
    throw new Error('saveAccountToken: missing accessToken')
  }
  const data: TokenData = {
    accessToken: poll.accessToken,
    refreshToken: poll.refreshToken,
    expiresAt: Date.now() + (poll.expiresIn ?? 3600) * 1000,
  }
  store.save(data)
  return data
}
