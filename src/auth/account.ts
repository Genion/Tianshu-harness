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

/**
 * `fetch` 注入点。
 *
 * 默认用全局 fetch。侧车（`rivet serve`）**必须**显式注入一个挂了代理
 * dispatcher 的 fetch：`setupHttpProxy()` 只被交互式会话的
 * `bootstrapInteractiveSession` 调用（`src/bootstrap.ts`），`src/server/serve.ts`
 * 有自己的入口，不经过它 —— 于是 serve 进程既不看 `HTTPS_PROXY` 也不看系统
 * 代理，配了代理的用户会卡在「等待授权」转圈。TUI 侧无需注入（那条路径已装
 * 全局 dispatcher）。
 */
export type FetchLike = typeof fetch

export interface FetchInjection {
  fetchImpl?: FetchLike
}

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

export interface RequestDeviceCodeOpts extends FetchInjection {
  tuiVersion?: string
  deviceName?: string
  /** 客户端持久硬件指纹——授权页用它作为设备标识（迁移 047 起） */
  deviceFingerprint?: string
}

/** 发起一次授权请求。调用方负责把 userCode / verifyUrl 展示给用户。 */
export async function requestDeviceCode(opts: RequestDeviceCodeOpts = {}): Promise<DeviceCreateResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(`${accountApiBase()}/functions/v1/tui-auth-create`, {
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
  const created = parseDeviceCreate((await res.json()) as Record<string, unknown>)
  // 补上 code：返回的链接必须是「拿去就能打开」的。EF 给的是页面基址，
  // 直接打开会停在授权页的「缺少授权码」态 —— 见 deviceAuthorizeUrl。
  return { ...created, verifyUrl: deviceAuthorizeUrl(created.verifyUrl, created.userCode) }
}

/**
 * 把 userCode 拼进授权页链接。
 *
 * 官网 `/auth/device` 从 `route.query.code` 取设备码，取不到就停在「缺少授权码」
 * 态（文案还写着「请从终端或桌面端的提示里复制完整链接，或在地址后补上
 * ?code= 参数」）；而 `tui-auth-create` 的 `verifyUrl` 是可配置的页面基址、
 * **不带 code**（2026-09-14 实测线上响应）。所以「拿到链接就能打开」这件事
 * 必须由客户端补齐——三端都从 `requestDeviceCode` 取链接，补一次就够。
 */
export function deviceAuthorizeUrl(verifyUrl: string, userCode: string): string {
  const sep = verifyUrl.includes('?') ? '&' : '?'
  return `${verifyUrl}${sep}code=${encodeURIComponent(userCode)}`
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

export interface PollOpts extends FetchInjection {
  intervalSeconds?: number
  timeoutMs?: number
  /** 每次 tick 回调（用于在同一行刷新进度，避免刷屏） */
  onTick?: (elapsedMs: number) => void
}

/**
 * 单次检查里的「可重试」失败：网络抖动、非 404 的 HTTP 错误。
 *
 * 与协议错误分开——响应结构不对（`approved` 却缺 accessToken）重试一万次也是
 * 同一个结果，只是把真正的原因（服务端契约变了）埋进 5 分钟后的「已过期」里。
 */
class TransientCheckError extends Error {}

/**
 * 问一次授权结果。
 *
 * `pollForAccountToken` 是「一直问到有结果」的完整流程（TUI 用）；本函数是
 * 「问一次」的原语，给桌面端 sidecar 路由用 —— 那条路上由前端按 pollInterval
 * 重发，因为 `rivetFetch` 有 15s 默认超时，长循环会被切断。
 *
 * 404 按 `expired` 返回：码被清理说明它已过期或不存在，继续问只是白等。
 *
 * @throws TransientCheckError（重试有意义）、parseDevicePoll 的协议错误（无意义）
 */
export async function checkDeviceOnce(
  deviceCode: string,
  opts: FetchInjection = {},
): Promise<DevicePollResult> {
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${accountApiBase()}/functions/v1/tui-auth-check`, {
      method: 'POST',
      headers: accountHeaders(),
      body: JSON.stringify({ deviceCode }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    throw new TransientCheckError((e as Error).message)
  }

  if (res.status === 404) return { status: 'expired' }
  if (!res.ok) throw new TransientCheckError(`device check failed: ${res.status}`)

  // 协议错误原样冒泡（parseDevicePoll 对「approved 无 token」抛错）
  return parseDevicePoll((await res.json()) as Record<string, unknown>)
}

/**
 * 轮询直到拿到 token 或进入终态。
 *
 * 单次网络抖动不终止整轮登录（等下一个 tick 再试）；协议错误立即冒泡 —— 见
 * `TransientCheckError`。
 */
export async function pollForAccountToken(
  deviceCode: string,
  opts: PollOpts = {},
): Promise<DevicePollResult> {
  const intervalMs = (opts.intervalSeconds ?? 5) * 1000
  const totalMs = opts.timeoutMs ?? 300_000
  const deadline = Date.now() + totalMs

  while (Date.now() < deadline) {
    try {
      const parsed = await checkDeviceOnce(deviceCode, { fetchImpl: opts.fetchImpl })
      if (parsed.status !== 'pending') return parsed
    } catch (e) {
      if (!(e instanceof TransientCheckError)) throw e
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

// ── 账号资料 ─────────────────────────────────────────────────────────────

export interface AccountProfile {
  email: string | null
  userId: string | null
}

/**
 * 拉账号资料（邮箱 / 用户 id）。Supabase Auth 的 `/auth/v1/user` 要用户 JWT。
 *
 * 失败返回 null 而不是抛：离线不该让「已登录」这个事实消失 —— 本地 token 还在，
 * 拉不到资料只说明网络不通，把状态报成「未登录」会误导用户重新登录一遍。
 */
export async function fetchAccountProfile(
  accessToken: string,
  opts: FetchInjection = {},
): Promise<AccountProfile | null> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${accountApiBase()}/auth/v1/user`, {
      method: 'GET',
      headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const raw = (await res.json()) as Record<string, unknown>
    return {
      email: typeof raw.email === 'string' ? raw.email : null,
      userId: typeof raw.id === 'string' ? raw.id : null,
    }
  } catch {
    return null
  }
}
