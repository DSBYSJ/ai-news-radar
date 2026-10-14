import { useEffect, useRef, useState } from 'react'

export interface BurstEvent {
  date: string
  category: string
  articleCount: number
  baseline: number
  z: number
  test?: boolean
}

interface FeedMessage {
  type: string
  items?: BurstEvent[]
  clients?: number
  recentBursts?: { date: string; category: string; article_count: number; baseline_mean: number; z_score: number }[]
}

/**
 * 突发实时推送（WebSocket /api/news/ws）：
 * - 复用同源 Cookie 鉴权（未登录会被 401 拒绝，这里静默降级并重试）；
 * - 断线自动重连（3s 起步、指数退避封顶 30s）；
 * - hello 消息里的最近突发也会回调一次（便于刚打开页面就有上下文）。
 */
export function useBurstFeed(onBurst: (items: BurstEvent[]) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false)
  const handlerRef = useRef(onBurst)
  handlerRef.current = onBurst

  useEffect(() => {
    let closed = false
    let socket: WebSocket | null = null
    let retry = 0
    let timer: number | undefined

    const connect = () => {
      if (closed) return
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      try {
        socket = new WebSocket(`${proto}//${window.location.host}/api/news/ws`)
      } catch {
        schedule()
        return
      }

      socket.onopen = () => {
        retry = 0
        setConnected(true)
      }

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as FeedMessage
          if (msg.type === 'burst' && msg.items && msg.items.length > 0) {
            handlerRef.current(msg.items)
          }
        } catch {
          // 忽略无法解析的消息
        }
      }

      socket.onclose = () => {
        setConnected(false)
        schedule()
      }
      socket.onerror = () => {
        try {
          socket?.close()
        } catch {
          // 忽略
        }
      }
    }

    const schedule = () => {
      if (closed) return
      const delay = Math.min(30_000, 3_000 * Math.pow(1.6, retry))
      retry += 1
      timer = window.setTimeout(connect, delay)
    }

    connect()

    return () => {
      closed = true
      if (timer) window.clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // 忽略
      }
      setConnected(false)
    }
  }, [])

  return { connected }
}
