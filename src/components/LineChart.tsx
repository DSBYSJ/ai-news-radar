import { shortDate } from '../utils/format.ts'
import { linePath, linearScale, niceTicks } from '../utils/scale.ts'

export interface Series {
  name: string
  color: string
  values: (number | null)[]
  dashed?: boolean
}

interface Props {
  labels: string[]
  series: Series[]
  height?: number
}

const W = 760
const PAD = { top: 14, right: 16, bottom: 26, left: 42 }

/** 手写 SVG 折线图（不引图表库）—— 支持多序列、空值断点、虚线 */
export default function LineChart({ labels, series, height = 220 }: Props) {
  const values = series
    .flatMap((s) => s.values)
    .filter((v): v is number => v !== null && Number.isFinite(v))
  const rawMax = values.length > 0 ? Math.max(...values) : 1
  const ticks = niceTicks(rawMax, 4)
  const top = ticks[ticks.length - 1] || 1

  const y = linearScale([0, top], [height - PAD.bottom, PAD.top])
  const x = linearScale([0, Math.max(1, labels.length - 1)], [PAD.left, W - PAD.right])
  const labelStep = Math.max(1, Math.ceil(labels.length / 8))

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#9ca3af">
              {t}
            </text>
          </g>
        ))}

        {labels.map((label, i) =>
          i % labelStep === 0 ? (
            <text key={label} x={x(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="#9ca3af">
              {shortDate(label)}
            </text>
          ) : null,
        )}

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
              strokeWidth={2}
              strokeDasharray={s.dashed ? '5 4' : undefined}
              strokeLinejoin="round"
            />
          )
        })}
      </svg>

      <div className="mt-2 flex flex-wrap gap-3">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-xs text-slate-600">
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
