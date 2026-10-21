/**
 * 瀑布图（归因拆解，item 4）
 *
 * 手写 SVG（项目约定不引图表库）：基础分 → 各项贡献 → 合计。
 * 每一根柱子的高度 = 该项对总分的贡献，正贡献向上、负贡献向下。
 */

export interface WaterfallItem {
  label: string
  value: number
  kind: 'base' | 'item' | 'total'
}

interface Props {
  items: WaterfallItem[]
  height?: number
}

const W = 660
const PAD_L = 8
const PAD_R = 8
const PAD_T = 16
const PAD_B = 44

export default function WaterfallChart({ items, height = 220 }: Props) {
  if (items.length === 0) return null

  // 计算每根柱子的起止高度
  let running = 0
  const bars = items.map((it) => {
    if (it.kind === 'base') {
      return { ...it, from: 0, to: 0 }
    }
    if (it.kind === 'total') {
      return { ...it, from: 0, to: it.value }
    }
    const from = running
    running += it.value
    return { ...it, from, to: running }
  })

  const maxV = Math.max(10, ...bars.map((b) => Math.max(b.from, b.to)))
  const minV = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)))
  const span = maxV - minV || 1
  const innerH = height - PAD_T - PAD_B
  const innerW = W - PAD_L - PAD_R
  const slot = innerW / bars.length
  const barW = Math.min(56, slot * 0.62)

  const yOf = (v: number): number => PAD_T + innerH - ((v - minV) / span) * innerH
  const zeroY = yOf(0)

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="危机风险分归因瀑布图">
      {/* 零线 */}
      <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} className="stroke-[var(--chart-baseline)]" strokeWidth="1" />

      {bars.map((b, i) => {
        const x = PAD_L + slot * i + (slot - barW) / 2
        const y = Math.min(yOf(b.from), yOf(b.to))
        const h = Math.max(2, Math.abs(yOf(b.from) - yOf(b.to)))
        const isTotal = b.kind === 'total'
        const isBase = b.kind === 'base'
        const positive = b.to >= b.from
        const fill = isBase
          ? 'var(--chart-grid)'
          : isTotal
            ? 'var(--accent)'
            : positive
              ? 'var(--hot)'
              : '#2f855a'
        const label = b.label.length > 7 ? `${b.label.slice(0, 6)}…` : b.label
        return (
          <g key={b.label + i}>
            <rect x={x} y={y} width={barW} height={h} rx="3" fill={fill} opacity={isBase ? 0.6 : 0.85} />
            {!isBase && (
              <text
                x={x + barW / 2}
                y={y - 4}
                textAnchor="middle"
                className="fill-slate-500 dark:fill-slate-400"
                style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
              >
                {b.value > 0 ? '+' : ''}
                {b.value}
              </text>
            )}
            <text
              x={x + barW / 2}
              y={height - PAD_B + 14}
              textAnchor="middle"
              className="fill-slate-400 dark:fill-slate-500"
              style={{ fontSize: 9.5 }}
            >
              {label}
            </text>
            {/* 连接线 */}
            {!isTotal && i < bars.length - 1 && (
              <line
                x1={x + barW}
                y1={yOf(b.to)}
                x2={PAD_L + slot * (i + 1) + (slot - barW) / 2}
                y2={yOf(b.to)}
                className="stroke-[var(--chart-sep)]"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}
