/**
 * SSE 活动连接注册表——服务端主动关停长连的显式通道（agent-13 修复）。
 *
 * 背景：/events、/sessions/:id/stream、/prompt 三条 SSE 长连只挂
 * `res.on('close')` / onDead 清理，这两条路径都只在「客户端断开」或「写失败」
 * 时触发。桌面客户端连着时收到 SIGINT/SIGTERM，服务端没有任何机制主动结束
 * 这些响应——http server.close(cb) 一直等 socket，cb 永不回调（
 * `process.exit(0)` 走不到），进程只能 kill -9（4ec384454 引入的挂起形态）。
 *
 * 注册表把「进程主动关停」变成一条显式路径：
 *   - 建连时 register；任一条清理路径（res 'close' / onDead / 本地 close）里 unregister；
 *   - 关停链先 closeAll()：每个连接发 done 帧 + end 响应 → 客户端读到 EOF 走退避；
 *   - 之后 server.close(cb) 收尾。注意 res.end 后 socket 转 keep-alive 空闲态，
 *     server.close 仍在等它——关停链必须紧跟 closeIdleConnections()
 *     （serve.ts close 链；否则要等 5s keepAliveTimeout，实测 5007ms）。
 */
export interface SseClosable {
  close(): void
}

export class SseConnectionRegistry {
  private readonly open = new Set<SseClosable>()

  register(connection: SseClosable): void {
    this.open.add(connection)
  }

  unregister(connection: SseClosable): void {
    this.open.delete(connection)
  }

  get size(): number {
    return this.open.size
  }

  /** 关停路径：快照后逐个 close（一个半死的连接不能拖累其余），再清空注册表。 */
  closeAll(): void {
    const snapshot = [...this.open]
    this.open.clear()
    for (const connection of snapshot) {
      try {
        connection.close()
      } catch {
        // 单个连接关闭失败必须不阻塞其余连接与关停链
      }
    }
  }
}
