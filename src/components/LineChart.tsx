import { useId, useState } from 'react'
import { shortDate } from '../utils/format.ts'
import { areaPath, linePath, linearScale, niceTicks } from '../utils/scale.ts'

export interface Series {
  name: string
  color: string
  values: (number | null)[]
  dashed?: boolean
  /** 线宽，默认 2 */
  width?: number
}

interface Props {
  labels: string[]
  series: Series[]
  height?: number
  /** 第一条序列画渐变面积填充（蓝 → 透明） */
  area?: boolean
  areaColor?: string
  /** 参考线（如均值线）：灰色虚线 + 标签 */
  reference?: { value: number; label: string }
  /** 数据点显示（白色描边圆点） */
  dots?: boolean
}

const W = 760
const PAD = { top: 14, right: 16, bottom: 26, left: 42 }

/** 手写 SVG 折线图：多序列 / 渐变面积 / 均值参考线 / 白描边数据点 / 悬浮提示 */
export default function LineChart({
  labels,
  series,
  height = 220,
  area = false,
  areaColor,
  reference,
  dots = false,
}: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const gradientId = useId()

  const values = series
    .flatMap((s) => s.values)
    .filter((v): v is number => v !== null && Number.isFinite(v))
  const rawMax = Math.max(values.length > 0 ? Math.max(...values) : 1, reference?.value ?? 0, 1)
  const ticks = niceTicks(rawMax, 4)
  const top = ticks[ticks.length - 1] || 1

  const y = linearScale([0, top], [height - PAD.bottom, PAD.top])
  const x = linearScale([0, Math.max(1, labels.length - 1)], [PAD.left, W - PAD.right])
  const labelStep = Math.max(1, Math.ceil(labels.length / 8))
  const slot = (W - PAD.left - PAD.right) / Math.max(1, labels.length)

  const first = series[0]
  const firstPts = first
    ? first.values
        .map((v, i) => (v === null ? null : { x: x(i), y: y(v) }))
        .filter((p): p is { x: number; y: number } => p !== null)
    : []

  const hoverPct = hover !== null ? ((PAD.left + slot * hover + slot / 2) / W) * 100 : 50

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
        {area && (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={areaColor ?? first?.color ?? '#3b82f6'} stopOpacity={0.32} />
              <stop offset="100%" stopColor={areaColor ?? first?.color ?? '#3b82f6'} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}

        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} strokeWidth={1} />
            <text className="chart-axis-text" x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11}>
              {t}
            </text>
          </g>
        ))}

        {reference && (
          <>
            <line
              className="chart-baseline"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(reference.value)}
              y2={y(reference.value)}
              strokeWidth={1}
              strokeDasharray="4 5"
            />
            <text className="chart-axis-text" x={W - PAD.right} y={y(reference.value) - 5} textAnchor="end" fontSize={10}>
              {reference.label}
            </text>
          </>
        )}

        {area && firstPts.length > 1 && <path d={areaPath(firstPts, y(0))} fill={`url(#${gradientId})`} stroke="none" />}

        {series.map((s) => {
          const pts = s.values
            .map((v, i) => (v === null ? null : { x: x(i), y: y(v) }))
            .filter((p): p is { x: number; y: number } => p !== null)
          if (pts.length === 0) return null
          return (
            <path
              key={s.name}
              d={linePath(pts)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width ?? 2}
              strokeDasharray={s.dashed ? '5 4' : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )
        })}

        {dots &&
          series.map((s) =>
            s.values.map((v, i) =>
              v === null ? null : (
                <circle key={`${s.name}-${i}`} className="chart-dot" cx={x(i)} cy={y(v)} r={3} fill={s.color} strokeWidth={1.5} />
              ),
            ),
          )}

        {/* 悬浮：竖线 + 整列命中区 */}
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
        {labels.map((lb, i) => (
          <rect
            key={`hit-${lb}`}
            x={PAD.left + slot * i}
            y={PAD.top}
            width={slot}
            height={height - PAD.bottom - PAD.top}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}

        {labels.map((lb, i) =>
          i % labelStep === 0 ? (
            <text key={lb} className="chart-axis-text" x={x(i)} y={height - 8} textAnchor="middle" fontSize={11}>
              {shortDate(lb)}
            </text>
          ) : null,
        )}
      </svg>

      {hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-28 rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800"
          style={{ left: `${Math.min(86, Math.max(14, hoverPct))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="mb-1 font-medium text-slate-800 dark:text-slate-100">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.name}
              <span className="ml-auto pl-3 font-medium text-slate-800 dark:text-slate-100">{s.values[hover] ?? '—'}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-3">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span
              className="inline-block h-0.5 w-4 rounded"
              style={{ backgroundColor: s.color, opacity: s.dashed ? 0.7 : 1 }}
            />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  )
}
