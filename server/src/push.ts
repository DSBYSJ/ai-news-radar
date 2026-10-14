/**
 * 实时推送中枢（单例）
 * 业务代码只管 broadcast，不依赖 Fastify / WebSocket 类型 ——
 * 连接管理在 ws.ts，流水线/调度器通过本模块广播。
 */
type Sink = (message: unknown) => void

const sinks = new Set<Sink>()

export function addSink(sink: Sink): void {
  sinks.add(sink)
}

export function removeSink(sink: Sink): void {
  sinks.delete(sink)
}

/** 向所有连接广播；返回实际投递数 */
export function broadcast(message: unknown): number {
  let delivered = 0
  for (const sink of sinks) {
    try {
      sink(message)
      delivered += 1
    } catch {
      // 单个连接失败不影响其它连接（ws.ts 会在 close/error 时清理）
    }
  }
  return delivered
}

export function sinkCount(): number {
  return sinks.size
}
