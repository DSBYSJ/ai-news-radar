import { bandOf, colorOf } from './riskColors.ts'

/**
 * 多因子雷达图（NFI 五维）
 *
 * 直观暴露风险结构是否「畸形」：某维度顶破边缘 = 该因子满格警报。
 * 手写 SVG 五边形网格 + 数据多边形；hover 高亮维度并回调联动。
 */

interface Props {
  factors: { key: string; label: string; score: number | null }[]
  size?: number
  onFactorHover?: (key: string | null) => void
}

const CENTER = 110
const R = 78

function pointAt(index: number, total: number, r: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / total
  return { x: CENTER + r * Math.cos(angle), y: CENTER + r * Math.sin(angle) }
}

export default function FactorRadar({ factors, size = 220, onFactorHover }: Props) {
  const n = factors.length
  if (n < 3) return null
  const rings = [0.25, 0.5, 0.75, 1]

  const polygon = (radius: number): string =>
    factors
      .map((_, i) => {
        const p = pointAt(i, n, radius)
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
      })
      .join(' ')

  const dataPoints = factors.map((f, i) => {
    const r = ((f.score ?? 0) / 100) * R
    return { ...f, ...pointAt(i, n, r) }
  })
  const dataPolygon = dataPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const maxed = dataPoints.filter((p) => (p.score ?? 0) >= 95)

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${CENTER * 2} ${CENTER * 2}`} width={size} height={size} role="img" aria-label="NFI 多因子雷达图">
        {/* 网格环 */}
        {rings.map((r) => (
          <polygon key={r} points={polygon(R * r)} fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="1" />
        ))}
        {/* 轴线 */}
        {factors.map((f, i) => {
          const p = pointAt(i, n, R)
          return <line key={f.key} x1={CENTER} y1={CENTER} x2={p.x} y2={p.y} stroke="rgba(148,163,184,0.18)" strokeWidth="1" />
        })}

        {/* 数据多边形 */}
        <polygon
          points={dataPolygon}
          fill="rgba(61,169,252,0.18)"
          stroke="#3da9fc"
          strokeWidth="2"
          style={{ filter: 'drop-shadow(0 0 8px rgba(61,169,252,0.35))' }}
        />

        {/* 数据点 + 标签 */}
        {dataPoints.map((p, i) => {
          const extreme = (p.score ?? 0) >= 95
          const labelPoint = pointAt(i, n, R + 18)
          return (
            <g
              key={p.key}
              onMouseEnter={() => onFactorHover?.(p.key)}
              onMouseLeave={() => onFactorHover?.(null)}
            >
              <circle
                cx={p.x}
                cy={p.y}
                r={extreme ? 5 : 3.5}
                fill={extreme ? '#e5484d' : colorOf(p.score)}
                className={extreme ? 'risk-breath' : ''}
              />
              {/* 更大的透明命中区，方便 hover */}
              <circle cx={p.x} cy={p.y} r="12" fill="transparent" />
              <text
                x={labelPoint.x}
                y={labelPoint.y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-slate-400"
                style={{ fontSize: 9 }}
              >
                {p.label}
              </text>
              <text
                x={labelPoint.x}
                y={labelPoint.y + 9}
                textAnchor="middle"
                className={extreme ? 'fill-[#e5484d]' : 'fill-slate-500'}
                style={{ fontSize: 8.5, fontVariantNumeric: 'tabular-nums' }}
              >
                {p.score ?? '—'}
              </text>
            </g>
          )
        })}
      </svg>
      {maxed.length > 0 && (
        <p className="mt-1 text-[10px] text-[#e5484d]">
          {maxed.map((m) => m.label).join('、')} 满格 · 风险结构偏畸形
        </p>
      )}
    </div>
  )
}

/** 供 Tooltip 说明分档（与 riskColors 一致） */
export function radarBandLabel(score: number | null): string {
  return { calm: '常态', attention: '关注', warn: '警告', critical: '高危' }[bandOf(score)]
}
