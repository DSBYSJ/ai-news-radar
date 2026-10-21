import { useEffect, useState } from 'react'
import { api } from '../api.ts'

/**
 * 风险历史回溯（item 7）
 *
 * 画 NFI 与 CRS 两条日曲线；标出已知的历史事件（硅谷银行、2022 概念股回调等），
 * 便于对照"分数高点"与"真实事件"是否对得上。
 */

interface HistoryPoint {
  date: string
  nfi: number | null
  crs: number | null
}

/** 已知历史事件（用于标注；日期为大致时间点） */
const EVENTS: { date: string; label: string }[] = [
  { date: '2023-03-10', label: '硅谷银行破产' },
  { date: '2022-06-15', label: 'AI 概念股回调' },
  { date: '2024-08-05', label: '日股闪崩' },
]

const W = 660
const H = 200
const PAD_L = 26
const PAD_R = 10
const PAD_T = 12
const PAD_B = 26

export default function RiskHistoryChart({ days = 180 }: { days?: number }) {
  const [points, setPoints] = useState<HistoryPoint[]>([])

  useEffect(() => {
    let alive = true
    api
      .riskHistory(days)
      .then((r) => {
        if (alive) setPoints(r.items)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [days])

  if (points.length < 2) {
    return (
      <p className="py-8 text-center text-[12px] text-slate-400 dark:text-slate-500">
        还没有历史快照 —— 到「后台 → 风险参数」点「异步重算」生成（也可在服务器执行
        <code className="num">npm run risk:backfill -- --apply</code>）
      </p>
    )
  }

  const maxV = 100
  const minV = 0
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const xOf = (i: number): number => PAD_L + (i / (points.length - 1)) * innerW
  const yOf = (v: number): number => PAD_T + innerH - ((v - minV) / (maxV - minV)) * innerH

  const path = (key: 'nfi' | 'crs'): string =>
    points
      .map((p, i) => {
        const v = p[key]
        if (v === null || v === undefined) return null
        return `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`
      })
      .filter(Boolean)
      .join(' ')

  const inRange = EVENTS.filter((e) => {
    const idx = points.findIndex((p) => p.date >= e.date)
    return idx >= 0
  })

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="NFI 与 CRS 历史走势">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line
              x1={PAD_L}
              y1={yOf(v)}
              x2={W - PAD_R}
              y2={yOf(v)}
              className="stroke-[var(--chart-grid)]"
              strokeWidth="1"
            />
            <text
              x={PAD_L - 6}
              y={yOf(v) + 3}
              textAnchor="end"
              className="fill-slate-400 dark:fill-slate-500"
              style={{ fontSize: 9 }}
            >
              {v}
            </text>
          </g>
        ))}

        {/* 事件标注 */}
        {inRange.map((e) => {
          const i = points.findIndex((p) => p.date >= e.date)
          if (i < 0) return null
          const x = xOf(i)
          return (
            <g key={e.date}>
              <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + innerH} className="stroke-[var(--hot)]" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
              <text
                x={x + 3}
                y={PAD_T + 10}
                className="fill-[var(--hot)]"
                style={{ fontSize: 9 }}
              >
                {e.label}
              </text>
            </g>
          )
        })}

        <path d={path('nfi')} fill="none" className="stroke-[var(--accent)]" strokeWidth="1.8" />
        <path d={path('crs')} fill="none" className="stroke-[var(--hot)]" strokeWidth="1.8" strokeDasharray="4 2" />

        <text x={PAD_L} y={H - 6} className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 9 }}>
          {points[0].date}
        </text>
        <text x={W - PAD_R} y={H - 6} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" style={{ fontSize: 9 }}>
          {points[points.length - 1].date}
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10.5px] text-slate-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 rounded bg-[var(--accent)]" /> NFI 叙事泡沫指数
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 rounded bg-[var(--hot)]" /> CRS 危机风险分
        </span>
        <span>共 {points.length} 个快照</span>
      </div>
    </div>
  )
}
