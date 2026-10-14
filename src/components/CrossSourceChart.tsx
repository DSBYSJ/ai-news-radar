import { useState } from 'react'
import type { CrossSourceEvent, CrossSourcePoint } from '../types.ts'
import { shortDate } from '../utils/format.ts'
import { linearScale, niceTicks } from '../utils/scale.ts'

interface Props {
  points: CrossSourcePoint[]
  /** 按日期分组的全部事件（悬浮提示用） */
  dayEvents?: Record<string, CrossSourceEvent[]>
  threshold?: number
  height?: number
}

const W = 760
const PAD = { top: 14, right: 16, bottom: 26, left: 42 }

/**
 * 跨源交叉度柱状图（第 4 层）：
 * - 柱高 = 当日事件的最大报道源数；≥3 家高亮为红色，其余浅蓝
 * - 红色虚线 = 3 家阈值线
 * - 鼠标悬浮柱子 → 该日全部跨源事件（标题 / 源列表 / 文章数）
 */
export default function CrossSourceChart({ points, dayEvents = {}, threshold = 3, height = 220 }: Props) {
  const [hover, setHover] = useState<number | null>(null)

  const rawMax = Math.max(threshold, ...points.map((p) => p.maxSources))
  const ticks = niceTicks(rawMax, 4)
  const top = ticks[ticks.length - 1] || threshold
  const y = linearScale([0, top], [height - PAD.bottom, PAD.top])
  const slot = (W - PAD.left - PAD.right) / Math.max(1, points.length)
  const barW = Math.max(4, slot * 0.6)
  const labelStep = Math.max(1, Math.ceil(points.length / 8))

  const hoveredPoint = hover !== null ? points[hover] : null
  const hoveredEvents = hoveredPoint ? (dayEvents[hoveredPoint.date] ?? []) : []
  // 让提示框尽量落在画布内（左右各留 12%）
  const hoverPct = hover !== null ? ((PAD.left + slot * hover + slot / 2) / W) * 100 : 50
  const leftPct = Math.min(88, Math.max(12, hoverPct))

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#9ca3af">
              {t}
            </text>
          </g>
        ))}

        {points.map((p, i) => {
          const cx = PAD.left + slot * i + slot / 2
          const h = Math.max(0, height - PAD.bottom - y(p.maxSources))
          const highlighted = hover === i
          return (
            <rect
              key={p.date}
              x={cx - barW / 2}
              y={y(p.maxSources)}
              width={barW}
              height={h}
              rx={2}
              fill={p.maxSources >= threshold ? '#dc2626' : '#93c5fd'}
              fillOpacity={hover === null || highlighted ? 1 : 0.45}
            />
          )
        })}

        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke="#dc2626"
          strokeWidth={1.5}
          strokeDasharray="6 4"
        />
        <text x={W - PAD.right} y={y(threshold) - 6} textAnchor="end" fontSize={11} fill="#dc2626">
          {threshold} 家独立源
        </text>

        {/* 整列命中区（透明 rect 保证细柱子也好悬浮） */}
        {points.map((p, i) => (
          <rect
            key={`hit-${p.date}`}
            x={PAD.left + slot * i}
            y={PAD.top}
            width={slot}
            height={height - PAD.bottom - PAD.top}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}

        {points.map((p, i) =>
          i % labelStep === 0 ? (
            <text key={p.date} x={PAD.left + slot * i + slot / 2} y={height - 8} textAnchor="middle" fontSize={11} fill="#9ca3af">
              {shortDate(p.date)}
            </text>
          ) : null,
        )}
      </svg>

      {hoveredPoint && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-72 rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800"
          style={{ left: `${leftPct}%`, transform: 'translateX(-50%)' }}
        >
          <div className="mb-1 font-medium text-slate-800 dark:text-slate-100">
            {hoveredPoint.date} · 最高 {hoveredPoint.maxSources} 家源 / {hoveredPoint.eventCount} 个事件
          </div>
          {hoveredEvents.length === 0 ? (
            <div className="text-slate-500 dark:text-slate-400">当日暂无跨源事件</div>
          ) : (
            <ul className="space-y-1.5">
              {hoveredEvents.slice(0, 4).map((e) => (
                <li key={e.eventKey}>
                  <div className="text-slate-700 dark:text-slate-200">
                    {e.title.length > 36 ? `${e.title.slice(0, 36)}…` : e.title}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400">
                    {e.sourceCount} 源 / {e.articleCount} 条 · {e.sources.join('、') || '（来源未知）'}
                  </div>
                </li>
              ))}
              {hoveredEvents.length > 4 && (
                <li className="text-slate-400 dark:text-slate-500">…另有 {hoveredEvents.length - 4} 个事件</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
