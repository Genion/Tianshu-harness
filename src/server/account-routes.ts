/**
 * 天枢账号路由——桌面端账号页经 sidecar 走 device flow。
 *
 * ## 为什么要有这一层
 * device flow 的实现只有一份（`src/auth/account.ts`），但桌面端的渲染进程
 * 拿不到它：那个模块依赖 `process.env`、`TokenStore` 文件落盘和 Node 的 fetch，
 * 是纯 Node 模块，WebView 里 import 不了。侧车 HTTP 是既定的跨端通道
 * （`rivetFetch` 自带 Bearer token），这里把账号能力挂上去。
 *
 * ## 两条不能破的线
 * 1. **凭据不出 sidecar**。`POST /account/poll` 拿到 `approved` 时由服务端直接
 *    落盘 `<RIVET_HOME>/account.json`，响应体只回状态——accessToken 不进
 *    WebView 的内存与 devtools。落盘位置与 CLI/TUI 共用，所以桌面端登录完，
 *    终端里的 `/status` 也认。
 * 2. **轮询是单次 check**，不是 `pollForAccountToken` 那个 5 分钟长循环：
 *    前端 `rivetFetch` 默认 15s 超时（`desktop/src/runtime/client.ts`），
 *    长循环会被切断。节奏由前端按 `pollInterval` 掌握。
 *
 * ## 代理
 * 侧车进程**不装配全局 dispatcher**：`setupHttpProxy()` 只被交互式会话的
 * `bootstrapInteractiveSession` 调用，`src/server/serve.ts` 有自己的入口不经过它。
 * 不管的话，配了代理的用户（官网反代正是为他们存在）会卡在「等待授权」转圈。
 * 所以这里在构建期解析一次代理并注入带 dispatcher 的 fetch。
 */
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'
import { resolveProxyForUrl } from '../tools/net/proxy-resolver.js'
import { rivetHome } from '../config/paths.js'
import * as accountModule from '../auth/account.js'
import type {
  AccountProfile,
  DeviceCreateResult,
  DevicePollResult,
  FetchInjection,
  FetchLike,
  RequestDeviceCodeOpts,
} from '../auth/account.js'
import type { TokenStore, TokenData } from '../auth/token-store.js'

/**
 * 路由需要的那部分账号能力。
 *
 * 抽成接口是为了单测能注入桩（网络面全假），而**落盘面在测试里用真实实现**——
 * 「凭据进文件、不进响应体」这条不变量只有真实磁盘能证。
 */
export interface AccountApi {
  requestDeviceCode(opts: RequestDeviceCodeOpts): Promise<DeviceCreateResult>
  checkDeviceOnce(deviceCode: string, opts?: FetchInjection): Promise<DevicePollResult>
  fetchAccountProfile(accessToken: string, opts?: FetchInjection): Promise<AccountProfile | null>
  accountStore(rivetHome: string): TokenStore
  saveAccountToken(store: TokenStore, poll: DevicePollResult): TokenData
}

export interface AccountRoutesDeps {
  /** 共享 Bearer token；缺省即 fail-closed（全 401）。 */
  apiToken?: string
  /** 账号凭据落盘根目录（与 CLI/TUI 同一个 RIVET_HOME）。 */
  rivetHome: string
  /** 注入点：默认走 `src/auth/account.ts` 的真实实现。 */
  account?: AccountApi
  /** `config.network.proxy`；未设时回退环境变量 / 系统代理。 */
  proxyUrl?: string
  /** `config.network.noProxy`。 */
  noProxy?: string
}

/** 按代理 URL 缓存 dispatcher——每请求新建会漏连接池。 */
const agents = new Map<string, ProxyAgent>()

function dispatcherFor(uri: string): ProxyAgent {
  let agent = agents.get(uri)
  if (!agent) {
    agent = new ProxyAgent({ uri })
    agents.set(uri, agent)
  }
  return agent
}

/**
 * 构建带代理 dispatcher 的 fetch；无代理时返回 undefined（调用方回退全局 fetch）。
 *
 * 目标 URL 只用于代理解析（NO_PROXY 匹配、协议选择），不参与请求本身——
 * 真正的请求 URL 由 `src/auth/account.ts` 按 `accountApiBase()` 拼。
 */
function buildProxyFetch(deps: AccountRoutesDeps): FetchLike | undefined {
  const target = accountModule.accountApiBase()
  const proxyUrl = resolveProxyForUrl(target, { proxyUrl: deps.proxyUrl, noProxy: deps.noProxy })
  if (!proxyUrl) return undefined
  const dispatcher = dispatcherFor(proxyUrl)
  // undici 的 fetch 接受 dispatcher，全局 fetch 的类型里没有这个字段——
  // 这里是有意的类型抹平，运行时形状一致（status/ok/json 都在）。
  return (async (input: unknown, init?: unknown) =>
    undiciFetch(input as string, {
      ...((init ?? {}) as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as FetchLike
}

function defaultAccountApi(): AccountApi {
  return {
    requestDeviceCode: accountModule.requestDeviceCode,
    checkDeviceOnce: accountModule.checkDeviceOnce,
    fetchAccountProfile: accountModule.fetchAccountProfile,
    accountStore: accountModule.accountStore,
    saveAccountToken: accountModule.saveAccountToken,
  }
}

export function buildAccountRoutes(deps: AccountRoutesDeps): Record<string, RouteHandler> {
  const api = deps.account ?? defaultAccountApi()
  // 代理在构建期解析一次：配置在进程生命周期内不变，而 macOS 的解析要起
  // `scutil --proxy` 子进程，逐请求跑是白付。
  const fetchImpl = buildProxyFetch(deps)
  // 与 /status、/abort 同一份认证实现（routes.ts 的 withAuth）——
  // 认证规则漂移出第二份就是安全洞。
  const guard = (handler: RouteHandler): RouteHandler => withAuth(handler, deps.apiToken)

  return {
    /** 申请设备码。前端拿 userCode/verifyUrl 去 openExternal，拿 deviceCode 轮询。 */
    'POST /account/device': guard(async (body) => {
      const input = (body ?? {}) as { deviceName?: unknown }
      const deviceName =
        typeof input.deviceName === 'string' && input.deviceName ? input.deviceName : undefined
      try {
        const created = await api.requestDeviceCode({ deviceName, fetchImpl })
        return { status: 200, body: created }
      } catch (e) {
        return { status: 502, body: { error: `device code request failed: ${(e as Error).message}` } }
      }
    }),

    /** 单次检查；approved 时落盘凭据，但只回状态。 */
    'POST /account/poll': guard(async (body) => {
      const input = (body ?? {}) as { deviceCode?: unknown }
      const deviceCode = typeof input.deviceCode === 'string' ? input.deviceCode.trim() : ''
      if (!deviceCode) return { status: 400, body: { error: 'deviceCode is required' } }

      let poll: DevicePollResult
      try {
        poll = await api.checkDeviceOnce(deviceCode, { fetchImpl })
      } catch (e) {
        return { status: 502, body: { error: `device check failed: ${(e as Error).message}` } }
      }

      if (poll.status !== 'approved') return { status: 200, body: { status: poll.status } }

      // `approved` 却缺 accessToken 在 saveAccountToken 里抛错——空凭据落盘会让
      // 下次启动谎报「已登录」，所以这里是 5xx 而不是 200。
      try {
        api.saveAccountToken(api.accountStore(deps.rivetHome), poll)
      } catch (e) {
        return { status: 500, body: { error: (e as Error).message } }
      }
      return { status: 200, body: { status: 'approved' } }
    }),

    /** 登录态。拉不到资料只降级 email，不改判登录与否。 */
    'GET /account/status': guard(async () => {
      const token = api.accountStore(deps.rivetHome).load()
      if (!token?.accessToken) {
        return { status: 200, body: { loggedIn: false, email: null, userId: null, expiresAt: null } }
      }

      let profile: AccountProfile | null = null
      try {
        profile = await api.fetchAccountProfile(token.accessToken, { fetchImpl })
      } catch {
        // 离线不等于未登录——本地 token 才是事实，拉不到资料只是拉不到
      }

      return {
        status: 200,
        body: {
          loggedIn: true,
          email: profile?.email ?? null,
          userId: profile?.userId ?? null,
          expiresAt: token.expiresAt,
        },
      }
    }),

    /** 只清账号凭据；provider 凭据按 provider 名分文件存放，登出不该连带清掉。 */
    'POST /account/logout': guard(async () => {
      api.accountStore(deps.rivetHome).clear()
      return { status: 200, body: { ok: true } }
    }),
  }
}

/**
 * serve.ts 的装配入口：配置与 RIVET_HOME 的解析都收在这一侧。
 *
 * 存在的理由是 `src/server/serve.ts` 是行数棘轮点名的巨石（只降不升，见
 * `scripts/source-budgets.manifest.json`），调用点因此只剩一行接线——与
 * `/project/trust` 路由当初的处置同构（主体在 trust-api.ts，serve 只接线）。
 *
 * config 用结构化类型而非 RivetConfig：这里只读 `network` 两个字段，避免为
 * 一个接线函数把整个配置 schema 拉进依赖。
 */
export function buildAccountRoutesFor(
  apiToken: string | undefined,
  config: { network?: { proxy?: string; noProxy?: string } },
): Record<string, RouteHandler> {
  return buildAccountRoutes({
    apiToken,
    rivetHome: rivetHome(),
    proxyUrl: config.network?.proxy,
    noProxy: config.network?.noProxy,
  })
}
