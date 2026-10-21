import { percentileColor } from './riskColors.ts'

/**
 * 迷你趋势图（Sparkline）
 * 手写 SVG 折线 + 尾点高亮；`history` 为升序数值序列。
 */
export function Sparkline({
  values,
  width = 120,
  height = 30,
  color = '#3da9fc',
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
}) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const xOf = (i: number): number => (i / (values.length - 1)) * (width - 4) + 2
  const yOf = (v: number): number => height - 3 - ((v - min) / span) * (height - 6)
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
  const lastX = xOf(values.length - 1)
  const lastY = yOf(values[values.length - 1])
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" opacity="0.85" />
      <circle cx={lastX} cy={lastY} r="2.4" fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
    </svg>
  )
}

/**
 * 宏观指标卡片（含迷你趋势 + 分位着色 + 点击下钻）
 */
export interface MacroCardData {
  key: string
  label: string
  display: string
  /** 历史分位 0~1 */
  percentile: number | null
  /** 一年前值（用于变化） */
  yearAgo: number | null
  yearAgoDisplay?: string
  /** 近 30 天走势（升序） */
  spark: number[]
  /** 现值（用于散点/联动） */
  raw: number
}

export default function MacroCard({ data, onDrill }: { data: MacroCardData; onDrill: () => void }) {
  const color = percentileColor(data.percentile)
  const change =
    data.yearAgo && data.yearAgo !== 0 ? ((data.raw - data.yearAgo) / Math.abs(data.yearAgo)) * 100 : null

  return (
    <button
      type="button"
      onClick={onDrill}
      className="group relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-left transition hover:border-white/15 hover:bg-white/[0.05]"
    >
      {/* 背景迷你趋势 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 opacity-40">
        <Sparkline values={data.spark} width={220} height={34} color={color} />
      </div>

      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.08em] text-slate-500">{data.label}</p>
          <p className="num mt-1 text-[20px] font-semibold leading-none" style={{ color }}>
            {data.display}
          </p>
          <p className="num mt-1.5 text-[9.5px] text-slate-500">
            {data.percentile !== null ? `历史分位 ${(data.percentile * 100).toFixed(0)}%` : '分位 —'}
            {change !== null && ` · 一年 ${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}
          </p>
        </div>
        <span className="mt-1 shrink-0 text-[9px] text-slate-600 transition group-hover:text-slate-400">
          下钻 ↗
        </span>
      </div>

      {/* 分位刻度条 */}
      <div className="relative mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${Math.min(100, (data.percentile ?? 0) * 100)}%`, backgroundColor: color }}
        />
      </div>
    </button>
  )
}
