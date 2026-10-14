import type { CategoryRatioPoint } from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, shortDate } from '../utils/format.ts'
import { areaPath, linearScale } from '../utils/scale.ts'

interface Props {
  points: CategoryRatioPoint[]
  categories: string[]
  height?: number
}

const W = 760
const PAD = { top: 14, right: 16, bottom: 26, left: 42 }

/**
 * 分类占比堆叠面积图（第 2 层）：Y 轴是占比不是条数，
 * 这样才排除了「源数量变化」造成的假趋势。
 */
export default function StackedAreaChart({ points, categories, height = 240 }: Props) {
  const y = linearScale([0, 1], [height - PAD.bottom, PAD.top])
  const x = linearScale([0, Math.max(1, points.length - 1)], [PAD.left, W - PAD.right])
  const labelStep = Math.max(1, Math.ceil(points.length / 8))

  const bands: { category: string; upper: { x: number; y: number }[] }[] = []
  const cumulative = points.map(() => 0)

  for (const category of categories) {
    const upper = points.map((p, i) => {
      cumulative[i] += p.ratios[category] ?? 0
      return { x: x(i), y: y(cumulative[i]) }
    })
    bands.push({ category, upper })
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((r) => (
          <g key={r}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(r)} y2={y(r)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(r) + 4} textAnchor="end" fontSize={11} fill="#9ca3af">
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}

        {points.map((p, i) =>
          i % labelStep === 0 ? (
            <text key={p.date} x={x(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="#9ca3af">
              {shortDate(p.date)}
            </text>
          ) : null,
        )}

        {bands.map((band) => (
          <g key={band.category}>
            <path
              d={areaPath(band.upper, y(0))}
              fill={CATEGORY_COLORS[band.category] ?? '#9ca3af'}
              fillOpacity={0.75}
            />
          </g>
        ))}
      </svg>

      <div className="mt-2 flex flex-wrap gap-3">
        {categories.map((c) => (
          <span key={c} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: CATEGORY_COLORS[c] ?? '#9ca3af' }}
            />
            {CATEGORY_LABELS[c] ?? c}
          </span>
        ))}
      </div>
    </div>
  )
}
