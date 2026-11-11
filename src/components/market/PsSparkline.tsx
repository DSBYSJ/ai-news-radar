/**
 * P/S 历史迷你曲线（按财年）+ 数值标注
 *
 * 之前只有一条 56×20 的细线：看不出"从多少到多少"，箭头也小得看不清。
 * 现在：面积填充 + 首尾点 + 起→止 数值 + 涨跌幅胶囊。
 * 颜色沿用 A 股/国内习惯：上涨（变贵）红、下跌（变便宜）绿。
 *
 * 数据来自 FMP 历史比率，每个财年一个点（2–8 个）。
 */

interface Props {
  points: { fiscalEnd: string; ps: number }[]
  width?: number
  height?: number
}

export default function PsSparkline({ points, width = 92, height = 28 }: Props) {
  if (points.length < 2) return <span className="text-[9.5px] text-slate-300 dark:text-slate-600">—</span>

  const values = points.map((p) => p.ps)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const xOf = (i: number): number => 3 + (i / (points.length - 1)) * (width - 8)
  const yOf = (v: number): number => height - 4 - ((v - min) / span) * (height - 9)
  const up = values[values.length - 1] >= values[0]
  const color = up ? '#e5484d' : '#22c55e'

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
  const area = `${line} L${xOf(values.length - 1).toFixed(1)},${height - 2} L${xOf(0).toFixed(1)},${height - 2} Z`
  const gradId = `psg-${points[0].fiscalEnd}-${points.length}-${up ? 'u' : 'd'}`

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="P/S 历史走势">
      <title>
        {points.map((p) => `${p.fiscalEnd.slice(0, 4)} 财年：${p.ps.toFixed(1)}x`).join('\n')}
      </title>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* 首值参考线：判断"现在比之前贵还是便宜"的基准 */}
      <line
        x1={xOf(0)}
        y1={yOf(values[0])}
        x2={xOf(values.length - 1)}
        y2={yOf(values[0])}
        stroke={color}
        strokeWidth="0.7"
        strokeDasharray="2 2"
        opacity="0.35"
      />

      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />

      {/* 起点（空心）与终点（实心 + 光晕） */}
      <circle cx={xOf(0)} cy={yOf(values[0])} r="1.8" fill="none" stroke={color} strokeWidth="1.2" opacity="0.8" />
      <circle
        cx={xOf(values.length - 1)}
        cy={yOf(values[values.length - 1])}
        r="2.6"
        fill={color}
        style={{ filter: `drop-shadow(0 0 3px ${color}aa)` }}
      />
    </svg>
  )
}

/** 表格单元格：曲线 + 起→止 数值 + 涨跌幅 */
export function PsTrendCell({ points }: { points: { fiscalEnd: string; ps: number }[] }) {
  if (points.length < 2) {
    return <span className="text-[9.5px] text-slate-300 dark:text-slate-600">—</span>
  }
  const first = points[0].ps
  const last = points[points.length - 1].ps
  const delta = first !== 0 ? (last - first) / first : null
  const up = last >= first
  const color = up ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
  const years = `${points[0].fiscalEnd.slice(0, 4)}→${points[points.length - 1].fiscalEnd.slice(0, 4)}`

  return (
    <div className="flex flex-col items-end gap-0.5">
      <PsSparkline points={points} />
      <div className="num flex items-center gap-1 text-[9.5px] leading-none">
        <span className="text-slate-500 dark:text-slate-400">
          {first.toFixed(1)}→{last.toFixed(1)}x
        </span>
        <span
          className={`rounded px-1 py-px font-medium ${color}`}
          style={{ backgroundColor: up ? 'rgba(229,72,77,0.12)' : 'rgba(34,197,94,0.12)' }}
        >
          {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}%`}
        </span>
      </div>
      <span className="num text-[8.5px] text-slate-400 dark:text-slate-500">{years} · {points.length} 个财年</span>
    </div>
  )
}
