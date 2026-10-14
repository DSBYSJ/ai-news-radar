import { useState } from 'react'
import type { CategoryRatioPoint } from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, formatPct, shortDate } from '../utils/format.ts'
import { areaPath, linearScale } from '../utils/scale.ts'

interface Props {
  points: CategoryRatioPoint[]
  categories: string[]
  height?: number
}

const W = 760
const PAD = { top: 14, right: 16, bottom: 26, left: 42 }

/**
 * 分类占比堆叠面积图（第 2 层）：
 * - 100% 堆积，低饱和莫兰迪配色；
 * - 图例可点击隐藏 / 显示某个类目（隐藏后会重新铺满 100%）；
 * - 悬浮显示当日各分类的具体占比（如 32.5%）。
 */
export default function StackedAreaChart({ points, categories, height = 240 }: Props) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<number | null>(null)

  const visible = categories.filter((c) => !hidden.has(c))

  const y = linearScale([0, 1], [height - PAD.bottom, PAD.top])
  const x = linearScale([0, Math.max(1, points.length - 1)], [PAD.left, W - PAD.right])
  const labelStep = Math.max(1, Math.ceil(points.length / 8))
  const slot = (W - PAD.left - PAD.right) / Math.max(1, points.length)

  // 堆叠（仅可见分类）
  const bands: { category: string; upper: { x: number; y: number }[] }[] = []
  const cumulative = points.map(() => 0)
  for (const category of visible) {
    const upper = points.map((p, i) => {
      cumulative[i] += p.ratios[category] ?? 0
      return { x: x(i), y: y(cumulative[i]) }
    })
    bands.push({ category, upper })
  }

  const toggle = (c: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const hoveredPoint = hover !== null ? points[hover] : null
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

        {bands.map((band) => (
          <path
            key={band.category}
            d={areaPath(band.upper, y(0))}
            fill={CATEGORY_COLORS[band.category] ?? '#9ca3af'}
            fillOpacity={0.8}
          />
        ))}

        {hover !== null && (
          <line
            className="chart-baseline"
            x1={x(hover)}
            x2={x(hover)}
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
            <text key={p.date} className="chart-axis-text" x={x(i)} y={height - 8} textAnchor="middle" fontSize={11}>
              {shortDate(p.date)}
            </text>
          ) : null,
        )}
      </svg>

      {hoveredPoint && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-52 rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800"
          style={{ left: `${Math.min(80, Math.max(20, hoverPct))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="mb-1.5 font-medium text-slate-800 dark:text-slate-100">
            {hoveredPoint.date} · 共 {hoveredPoint.total} 条
          </div>
          <ul className="space-y-1">
            {visible
              .map((c) => ({ c, ratio: hoveredPoint.ratios[c] ?? 0 }))
              .filter((r) => r.ratio > 0)
              .sort((a, b) => b.ratio - a.ratio)
              .slice(0, 6)
              .map(({ c, ratio }) => (
                <li key={c} className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: CATEGORY_COLORS[c] ?? '#9ca3af' }}
                  />
                  {CATEGORY_LABELS[c] ?? c}
                  <span className="ml-auto pl-3 font-medium text-slate-800 dark:text-slate-100">{formatPct(ratio)}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* 图例：点击隐藏 / 显示某个类目 */}
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
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: CATEGORY_COLORS[c] ?? '#9ca3af' }}
              />
              {CATEGORY_LABELS[c] ?? c}
            </button>
          )
        })}
      </div>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">点击图例可隐藏 / 显示该分类</p>
    </div>
  )
}
