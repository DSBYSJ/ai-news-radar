import websocket from '@fastify/websocket'
import type { FastifyInstance } from 'fastify'
import { addSink, removeSink, sinkCount } from './push.ts'

/**
 * WebSocket 路由：/api/news/ws
 * - 与其它 /api/news/* 一样走鉴权中间件（未登录无法建立连接）；
 * - 建立连接后先推一条 hello（含连接数与最近突发）；
 * - 新的突发（z ≥ 2.5）由流水线/调度器通过 push.broadcast 实时下发。
 */
export async function registerWs(app: FastifyInstance, hello: () => Record<string, unknown>): Promise<void> {
  await app.register(websocket)

  app.get('/api/news/ws', { websocket: true }, (socket) => {
    const sink = (message: unknown) => socket.send(JSON.stringify(message))
    addSink(sink)

    try {
      socket.send(JSON.stringify({ type: 'hello', clients: sinkCount(), ...hello() }))
    } catch {
      // 连接刚建立即断开，忽略
    }

    const cleanup = () => removeSink(sink)
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })
}
