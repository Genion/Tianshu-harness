import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { createProviderClient, type RuntimeParams } from '../factory.js'
import { resolveCapabilities } from '../provider.js'
import type { ProviderConfig } from '../../config/schema.js'

/**
 * baseUrl 归一化回归测试。
 *
 * 缺陷：`normalizeBaseUrl()` 只在 provider-probe 的连通性探测里生效，对话发送
 * 路径（openai-client 拼 `${baseUrl}/chat/completions`）用的是原始 baseUrl。
 * 于是在 Base URL 里粘贴 curl 全文（`…/api/paas/v4/chat/completions`）时，
 * 探测 200、对话 404 —— 症状正是「接上了但对话没反应」。
 *
 * 不变量：无论 baseUrl 带不带请求路径尾巴，实际 POST 的 URL 必须以恰好一个
 * `/chat/completions` 结尾。
 */

function openaiStyleProvider(baseUrl: string): ProviderConfig {
  return {
    name: 'glm',
    baseUrl,
    protocol: 'openai',
    capabilities: {
      cacheControl: false,
      stripParams: [],
      toolJsonBug: false,
      prefixCache: 'none',
      prefixCompletion: false,
    },
    models: [{ id: 'glm-test', contextWindow: 1_000_000, maxTokens: 65536 }],
    unsupported: [],
  } as unknown as ProviderConfig
}

const runtimeParams: RuntimeParams = {
  apiKey: 'test-key',
  model: 'glm-test',
  maxTokens: 128,
}

const MINIMAL_SSE =
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

/** 发一次 stream()，捕获实际出站 URL。 */
async function captureRequestUrl(baseUrl: string): Promise<string> {
  const client = createProviderClient(
    openaiStyleProvider(baseUrl),
    resolveCapabilities('glm'),
    runtimeParams,
  )

  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
    capturedUrl = String(url)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(MINIMAL_SSE))
        controller.close()
      },
    })
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  try {
    await client.stream(
      { model: 'glm-test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 } as never,
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: () => {},
      } as never,
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(capturedUrl, 'fetch 未被调用 —— 请求根本没发出去，测试前提不成立')
  return capturedUrl
}

describe('baseUrl normalization on the send path', () => {
  it('不双重拼接：用户粘贴完整请求 URL 时仍只发一个 /chat/completions', async () => {
    const url = await captureRequestUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
    assert.doesNotMatch(url, /chat\/completions\/chat\/completions$/)
  })

  it('已归一化的 /vN base URL 原样透传', async () => {
    assert.equal(
      await captureRequestUrl('https://api.deepseek.com/v1'),
      'https://api.deepseek.com/v1/chat/completions',
    )
  })

  it('尾部斜杠不产生双斜杠', async () => {
    assert.equal(
      await captureRequestUrl('https://api.example.com/v1/'),
      'https://api.example.com/v1/chat/completions',
    )
  })

  it('剥掉其他可粘贴的请求路径尾巴（/messages、/models）', async () => {
    assert.equal(
      await captureRequestUrl('https://api.example.com/v1/messages'),
      'https://api.example.com/v1/chat/completions',
    )
    assert.equal(
      await captureRequestUrl('https://api.example.com/v1/models'),
      'https://api.example.com/v1/chat/completions',
    )
  })
})
