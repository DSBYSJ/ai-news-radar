import { useState } from 'react'
import { colorOf } from './riskColors.ts'

/**
 * NFI 归因瀑布图（堆叠柱模拟：透明底柱 + 彩色贡献段）
 *
 * 与旧版 WaterfallChart 的区别：
 *   - 长说明文字收进 hover tooltip（不再铺在页面上）
 *   - 满格指标（≥95）加「警灯呼吸」动效
 *   - hover 柱子时向上传 `onFactorHover`，联动历史折线高亮
 */

/** 展示用短标签（tooltip 里仍显示全称） */
const SHORT: Record<string, string> = {
  money: '融资密度',
  sentiment: '情绪偏正',
  concentration: '叙事集中',
  acceleration: '热度加速',
  fomo: 'FOMO',
}

export interface WaterfallFactor {
  key: string
  label: string
  value: number | null
  score: number | null
  weight: number
  contribution: number
  note: string
}

interface Props {
  factors: WaterfallFactor[]
  total: number | null
  height?: number
  onFactorHover?: (key: string | null) => void
}

const W = 640
const PAD_L = 6
const PAD_R = 6
const PAD_T = 18
const PAD_B = 40

export default function NfiWaterfall({ factors, total, height = 210, onFactorHover }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const items = factors.map((f) => ({ ...f, kind: 'item' as const }))

  /*
   * 柱子贴底（高度 = 该因子贡献），不悬空；
   * 累加语义用「阶梯虚线」保留：从上一根柱顶连到下一根柱顶。
   */
  let running = 0
  const bars = items.map((f) => {
    const from = running
    running += f.contribution
    return { ...f, from, to: running, height: f.contribution }
  })
  const maxV = Math.max(10, ...bars.map((b) => Math.max(b.from, b.to)), total ?? 0)

  const innerH = height - PAD_T - PAD_B
  const innerW = W - PAD_L - PAD_R
  const slot = innerW / (bars.length + 1) // +1 给合计柱
  const barW = Math.min(58, slot * 0.58)
  const yOf = (v: number): number => PAD_T + innerH - (v / maxV) * innerH

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="NFI 归因瀑布图">
        <line x1={PAD_L} y1={PAD_T + innerH} x2={W - PAD_R} y2={PAD_T + innerH} className="stroke-[var(--chart-baseline)]" strokeWidth="1" />

        {bars.map((b, i) => {
          const x = PAD_L + slot * i + (slot - barW) / 2
          const baseline = PAD_T + innerH
          const y = yOf(b.height) // 贴底：顶端 = 贡献值高度
          const h = Math.max(2, baseline - y)
          const isExtreme = b.score !== null && b.score >= 95
          const fill = colorOf(b.score)
          const isHover = hover === b.key
          return (
            <g
              key={b.key}
              onMouseEnter={() => {
                setHover(b.key)
                onFactorHover?.(b.key)
              }}
              onMouseLeave={() => {
                setHover(null)
                onFactorHover?.(null)
              }}
            >
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx="4"
                fill={fill}
                opacity={isHover ? 1 : 0.82}
                className={isExtreme ? 'risk-breath' : ''}
                style={{ filter: `drop-shadow(0 0 6px ${fill}55)` }}
              />
              {/* 阶梯虚线：保留"累加"语义（柱顶 → 下一根柱顶） */}
              {i < bars.length - 1 && (
                <line
                  x1={x + barW}
                  y1={yOf(b.to)}
                  x2={PAD_L + slot * (i + 1) + (slot - barW) / 2}
                  y2={yOf(b.to)}
                  stroke="rgba(148,163,184,0.55)"
                  strokeWidth="1"
                  strokeDasharray="3 2"
                />
              )}
              <text
                x={x + barW / 2}
                y={y - 5}
                textAnchor="middle"
                className="fill-slate-300"
                style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
              >
                +{b.contribution.toFixed(1)}
              </text>
              <text
                x={x + barW / 2}
                y={PAD_T + innerH + 13}
                textAnchor="middle"
                className={isHover ? 'fill-slate-200' : 'fill-slate-400'}
                style={{ fontSize: 9.5 }}
              >
                {SHORT[b.key] ?? b.label}
              </text>
              {isExtreme && (
                <text
                  x={x + barW / 2}
                  y={PAD_T + innerH + 25}
                  textAnchor="middle"
                  className="fill-[#e5484d]"
                  style={{ fontSize: 8 }}
                >
                  满格
                </text>
              )}
            </g>
          )
        })}

        {/* 合计柱 */}
        {(() => {
          const x = PAD_L + slot * bars.length + (slot - barW) / 2
          const v = total ?? running
          const y = yOf(v)
          const h = Math.max(2, PAD_T + innerH - y)
          return (
            <g>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx="4"
                fill={colorOf(v)}
                opacity="0.95"
                style={{ filter: `drop-shadow(0 0 10px ${colorOf(v)}66)` }}
              />
              <text
                x={x + barW / 2}
                y={y - 5}
                textAnchor="middle"
                className="fill-slate-100"
                style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
              >
                {v.toFixed(0)}
              </text>
              <text x={x + barW / 2} y={PAD_T + innerH + 13} textAnchor="middle" className="fill-slate-300" style={{ fontSize: 9.5 }}>
                合计
              </text>
            </g>
          )
        })()}
      </svg>

      {/* Tooltip：长说明收在这里（不再铺在页面上） */}
      {hover &&
        (() => {
          const f = items.find((x) => x.key === hover)
          if (!f) return null
          return (
            <div
              className="pointer-events-none absolute left-3 top-2 max-w-[280px] rounded-lg border border-white/10 bg-[#0d1117]/95 px-2.5 py-2 text-[10.5px] leading-relaxed text-slate-300 shadow-2xl"
              style={{ backdropFilter: 'blur(8px)' }}
            >
              <p className="font-medium text-slate-100">
                {f.label} · {f.score === null ? '未参与' : `${f.score} 分`} × {f.weight}%
              </p>
              <p className="mt-1 text-slate-400">{f.note}</p>
            </div>
          )
        })()}
    </div>
  )
}
