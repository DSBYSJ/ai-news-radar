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
  /** 区间带（如预测置信带），数组与 labels 对齐；null 表示该位置不画 */
  bands?: { color: string; lo: (number | null)[]; hi: (number | null)[] }[]
  /** 固定 Y 轴上界（占比图传 1）；不传则自动按数据取整刻度 */
  yMax?: number
  /** Y 轴刻度文案格式化（如 v => `${Math.round(v * 100)}%`） */
  tickFormat?: (v: number) => string
  /** 悬浮提示里数值的格式化 */
  valueFormat?: (v: number) => string
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
  bands,
  yMax,
  tickFormat,
  valueFormat,
}: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const gradientId = useId()

  const values = series
    .flatMap((s) => s.values)
    .filter((v): v is number => v !== null && Number.isFinite(v))
  const bandMax = bands
    ? Math.max(
        0,
        ...bands.flatMap((b) => b.hi.filter((v): v is number => v !== null && Number.isFinite(v))),
      )
    : 0
  const rawMax = Math.max(values.length > 0 ? Math.max(...values) : 1, reference?.value ?? 0, bandMax, 1)
  const ticks = yMax !== undefined ? [0, 0.25, 0.5, 0.75, 1].map((r) => Number((r * yMax).toFixed(4))) : niceTicks(rawMax, 4)
  const top = (yMax ?? ticks[ticks.length - 1]) || 1

  const y = linearScale([0, top], [height - PAD.bottom, PAD.top])
  const x = linearScale([0, Math.max(1, labels.length - 1)], [PAD.left, W - PAD.right])
  const labelStep = Math.max(1, Math.ceil(labels.length / 8))
  // 命中区宽度按点数均分；居中在 x(i) 上（下面用 x(i) - slot/2 定位）
  const slot = (W - PAD.left - PAD.right) / Math.max(1, labels.length - 1)

  const first = series[0]
  const firstPts = first
    ? first.values
        .map((v, i) => (v === null ? null : { x: x(i), y: y(v) }))
        .filter((p): p is { x: number; y: number } => p !== null)
    : []

  const hoverPct = hover !== null ? (x(hover) / W) * 100 : 50

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
              {tickFormat ? tickFormat(t) : t}
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

        {bands?.map((band, bi) => {
          const pts = labels
            .map((_, i) => {
              const lo = band.lo[i]
              const hi = band.hi[i]
              if (lo === null || lo === undefined || hi === null || hi === undefined) return null
              return { x: x(i), loY: y(lo), hiY: y(hi) }
            })
            .filter((p): p is { x: number; loY: number; hiY: number } => p !== null)
          if (pts.length < 2) return null
          const upper = pts.map((p) => `${p.x},${p.hiY}`).join(' L ')
          const lower = [...pts].reverse().map((p) => `${p.x},${p.loY}`).join(' L ')
          return <path key={bi} d={`M ${upper} L ${lower} Z`} fill={band.color} fillOpacity={0.16} stroke="none" />
        })}

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
        {labels.map((lb, i) => {
          // 居中在数据点上：左右各留 slot/2，首尾两列贴住绘图区边界
          const left = Math.max(PAD.left, x(i) - slot / 2)
          const right = Math.min(W - PAD.right, x(i) + slot / 2)
          return (
            <rect
              key={`hit-${lb}`}
              x={left}
              y={PAD.top}
              width={Math.max(1, right - left)}
              height={height - PAD.bottom - PAD.top}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}

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
              <span className="ml-auto pl-3 font-medium text-slate-800 dark:text-slate-100">
                {s.values[hover] === null || s.values[hover] === undefined
                  ? '—'
                  : valueFormat
                    ? valueFormat(s.values[hover] as number)
                    : s.values[hover]}
              </span>
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
