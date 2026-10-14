import { useState } from 'react'
import type { CategoryRatioPoint } from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, formatPct, shortDate } from '../utils/format.ts'
import { linearScale } from '../utils/scale.ts'

interface Props {
  points: CategoryRatioPoint[]
  categories: string[]
  height?: number
  /** 覆盖配色（如情感图用 正绿/中灰/负红） */
  colors?: Record<string, string>
  /** 覆盖显示名（如 positive → 正面） */
  labelMap?: Record<string, string>
}

const W = 760
const PAD = { top: 14, right: 16, bottom: 26, left: 42 }

/**
 * 100% 堆积柱（第 2 层）：
 * - 每根柱子 = 某天收录内容的分类构成占比；
 *   相比面积图，数据稀疏的日子不会再"塌陷成三角峡谷"（此前可读性差的根因）；
 * - 柱内分段用卡片底色描边，段与段边界清晰；
 * - 悬浮查看当日各分类具体占比（如 32.5%）；点击图例可隐藏某类。
 */
export default function StackedBarChart({ points, categories, height = 260, colors, labelMap }: Props) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<number | null>(null)

  const colorOf = (c: string) => colors?.[c] ?? CATEGORY_COLORS[c] ?? '#9ca3af'
  const labelOf = (c: string) => labelMap?.[c] ?? CATEGORY_LABELS[c] ?? c

  const visible = categories.filter((c) => !hidden.has(c))
  const slot = (W - PAD.left - PAD.right) / Math.max(1, points.length)
  const barW = Math.max(3, Math.min(18, slot * 0.72))
  const y = linearScale([0, 1], [height - PAD.bottom, PAD.top])
  const labelStep = Math.max(1, Math.ceil(points.length / 10))

  // 每根柱：自底向上按（可见分类的固定顺序）堆叠；柱高 = 可见分类合计占比
  const bars = points.map((p) => {
    const segments: { category: string; from: number; to: number }[] = []
    let acc = 0
    for (const c of visible) {
      const ratio = p.ratios[c] ?? 0
      if (ratio <= 0) continue
      segments.push({ category: c, from: acc, to: acc + ratio })
      acc += ratio
    }
    return { date: p.date, total: p.total, segments, sum: acc }
  })

  const toggle = (c: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const hovered = hover !== null ? points[hover] : null
  const hoverPct = hover !== null ? ((PAD.left + slot * hover + slot / 2) / W) * 100 : 50

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((r) => (
          <g key={r}>
            <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(r)} y2={y(r)} strokeWidth={1} />
            <text className="chart-axis-text" x={PAD.left - 8} y={y(r) + 4} textAnchor="end" fontSize={11}>
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}

        {points.map((p, i) => {
          const bar = bars[i]
          if (bar.sum <= 0) return null
          const cx = PAD.left + slot * i + slot / 2
          return (
            <g key={p.date} opacity={hover === null || hover === i ? 1 : 0.4}>
              {bar.segments.map((s) => {
                const yTop = y(s.to)
                const h = Math.max(1, y(s.from) - y(s.to))
                return (
                  <rect
                    key={s.category}
                    x={cx - barW / 2}
                    y={yTop}
                    width={barW}
                    height={h}
                    fill={colorOf(s.category)}
                    className="chart-sep"
                    strokeWidth={1}
                  />
                )
              })}
            </g>
          )
        })}

        {hover !== null && (
          <line
            className="chart-baseline"
            x1={PAD.left + slot * hover + slot / 2}
            x2={PAD.left + slot * hover + slot / 2}
            y1={PAD.top}
            y2={height - PAD.bottom}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}

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
            <text
              key={p.date}
              className="chart-axis-text"
              x={PAD.left + slot * i + slot / 2}
              y={height - 8}
              textAnchor="middle"
              fontSize={11}
            >
              {shortDate(p.date)}
            </text>
          ) : null,
        )}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-52 rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800"
          style={{ left: `${Math.min(80, Math.max(20, hoverPct))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="mb-1.5 font-medium text-slate-800 dark:text-slate-100">
            {hovered.date} · 共 {hovered.total} 条
          </div>
          {hovered.total === 0 ? (
            <div className="text-slate-500 dark:text-slate-400">当日无收录</div>
          ) : (
            <ul className="space-y-1">
              {visible
                .map((c) => ({ c, ratio: hovered.ratios[c] ?? 0 }))
                .filter((r) => r.ratio > 0)
                .sort((a, b) => b.ratio - a.ratio)
                .slice(0, 6)
                .map(({ c, ratio }) => (
                  <li key={c} className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: colorOf(c) }} />
                    {labelOf(c)}
                    <span className="ml-auto pl-3 font-medium text-slate-800 dark:text-slate-100">{formatPct(ratio)}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {categories.map((c) => {
          const off = hidden.has(c)
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              title={off ? '点击显示' : '点击隐藏'}
              className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition ${
                off
                  ? 'text-slate-400 line-through opacity-50 dark:text-slate-500'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colorOf(c) }} />
              {labelOf(c)}
            </button>
          )
        })}
      </div>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        点击图例可隐藏 / 显示该分类；隐藏后柱子高度 = 剩余分类的合计占比
      </p>
    </div>
  )
}
