/**
 * P/S 历史迷你曲线（按财年）
 *
 * 数据来自 FMP 历史比率（每个财年一个点，2–8 个）。点少，所以画折线 + 端点，
 * 不做坐标轴 —— 只用来回答"这家公司的倍数是在爬还是在退"。
 */

interface Props {
  points: { fiscalEnd: string; ps: number }[]
  width?: number
  height?: number
  color?: string
}

export default function PsSparkline({ points, width = 56, height = 20, color = '#3da9fc' }: Props) {
  if (points.length < 2) return <span className="text-[9.5px] text-slate-300 dark:text-slate-600">—</span>

  const values = points.map((p) => p.ps)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const xOf = (i: number): number => 2 + (i / (points.length - 1)) * (width - 4)
  const yOf = (v: number): number => height - 3 - ((v - min) / span) * (height - 6)
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
  const lastX = xOf(values.length - 1)
  const lastY = yOf(values[values.length - 1])
  const up = values[values.length - 1] >= values[0]

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="P/S 历史走势">
      <title>
        {points.map((p) => `${p.fiscalEnd.slice(0, 4)}: ${p.ps.toFixed(1)}x`).join(' · ')}
      </title>
      <path d={d} fill="none" stroke={color} strokeWidth="1.3" opacity="0.9" />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
      <text x={width - 1} y={7} textAnchor="end" className={up ? 'fill-red-400' : 'fill-emerald-400'} style={{ fontSize: 7 }}>
        {up ? '↑' : '↓'}
      </text>
    </svg>
  )
}
