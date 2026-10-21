import { useRef, useState } from 'react'
import { colorOf } from './riskColors.ts'

/**
 * 历史时间序列折线（带十字准星 + 因子联动高亮）
 *
 * - 双曲线：NFI（实线）/ CRS（虚线）
 * - `overlay`：hover 瀑布/雷达的某个因子时，叠加显示该因子的历史分数曲线（半透明）
 * - mousemove 出十字准星 + 数值提示；支持移动端 touchmove
 */

interface Point {
  date: string
  nfi: number | null
  crs: number | null
}

interface Props {
  points: Point[]
  overlay?: { name: string; values: (number | null)[]; color: string } | null
  height?: number
  events?: { date: string; label: string }[]
}

const W = 660
const PAD_L = 26
const PAD_R = 10
const PAD_T = 12
const PAD_B = 24

export default function HistoryLine({ points, overlay, height = 210, events = [] }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  if (points.length < 2) {
    return (
      <p className="py-8 text-center text-[11px] text-slate-500">
        没有历史快照 —— 到「后台 → 风险参数」点「保存并异步重算」生成
      </p>
    )
  }

  const innerW = W - PAD_L - PAD_R
  const innerH = height - PAD_T - PAD_B
  const xOf = (i: number): number => PAD_L + (i / (points.length - 1)) * innerW
  const yOf = (v: number): number => PAD_T + innerH - (v / 100) * innerH

  const linePath = (key: 'nfi' | 'crs'): string =>
    points
      .map((p, i) => {
        const v = p[key]
        return v === null || v === undefined ? null : `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`
      })
      .filter(Boolean)
      .join(' ')

  const overlayPath = overlay
    ? overlay.values
        .map((v, i) => (v === null || v === undefined ? null : `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`))
        .filter(Boolean)
        .join(' ')
    : ''

  const handleMove = (clientX: number): void => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const x = ((clientX - rect.left) / rect.width) * W
    const idx = Math.round(((x - PAD_L) / innerW) * (points.length - 1))
    setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)))
  }

  const active = hoverIdx !== null ? points[hoverIdx] : null

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        className="w-full cursor-crosshair"
        role="img"
        aria-label="NFI 与 CRS 历史走势"
        onMouseMove={(e) => handleMove(e.clientX)}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchMove={(e) => handleMove(e.touches[0].clientX)}
        onTouchEnd={() => setHoverIdx(null)}
      >
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={PAD_L} y1={yOf(v)} x2={W - PAD_R} y2={yOf(v)} className="stroke-[var(--chart-grid)]" strokeWidth="1" />
            <text x={PAD_L - 5} y={yOf(v) + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 8.5 }}>
              {v}
            </text>
          </g>
        ))}

        {/* 事件标注（窗口内） */}
        {events
          .filter((e) => e.date >= points[0].date && e.date <= points[points.length - 1].date)
          .map((e, k) => {
            const idx = points.findIndex((p) => p.date >= e.date)
            if (idx < 0) return null
            const x = xOf(idx)
            return (
              <g key={e.date}>
                <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + innerH} stroke="rgba(229,72,77,0.5)" strokeWidth="1" strokeDasharray="3 3" />
                <text x={x + 3} y={PAD_T + 10 + (k % 3) * 11} className="fill-[#e5484d]" style={{ fontSize: 8.5 }}>
                  {e.label}
                </text>
              </g>
            )
          })}

        {/* 因子联动曲线（半透明叠加） */}
        {overlay && overlayPath && (
          <g>
            <path d={overlayPath} fill="none" stroke={overlay.color} strokeWidth="1.6" opacity="0.75" strokeDasharray="5 3" />
            <text x={W - PAD_R} y={PAD_T + 8} textAnchor="end" className="fill-slate-300" style={{ fontSize: 9 }}>
              {overlay.name}
            </text>
          </g>
        )}

        <path d={linePath('nfi')} fill="none" stroke="#3da9fc" strokeWidth="2" />
        <path d={linePath('crs')} fill="none" stroke="#f5a623" strokeWidth="2" strokeDasharray="5 3" />

        {/* 十字准星 */}
        {hoverIdx !== null && (
          <g>
            <line x1={xOf(hoverIdx)} y1={PAD_T} x2={xOf(hoverIdx)} y2={PAD_T + innerH} stroke="rgba(148,163,184,0.5)" strokeWidth="1" />
            {points[hoverIdx].nfi !== null && (
              <circle cx={xOf(hoverIdx)} cy={yOf(points[hoverIdx].nfi!)} r="3.5" fill="#3da9fc" stroke="#0d1117" strokeWidth="1.5" />
            )}
            {points[hoverIdx].crs !== null && (
              <circle cx={xOf(hoverIdx)} cy={yOf(points[hoverIdx].crs!)} r="3.5" fill="#f5a623" stroke="#0d1117" strokeWidth="1.5" />
            )}
          </g>
        )}

        <text x={PAD_L} y={height - 6} className="fill-slate-500" style={{ fontSize: 8.5 }}>
          {points[0].date}
        </text>
        <text x={W - PAD_R} y={height - 6} textAnchor="end" className="fill-slate-500" style={{ fontSize: 8.5 }}>
          {points[points.length - 1].date}
        </text>
      </svg>

      {/* 数值提示 */}
      {active && (
        <div
          className="pointer-events-none absolute top-1 rounded-lg border border-white/10 bg-[#0d1117]/95 px-2.5 py-1.5 text-[10px] text-slate-300"
          style={{ left: `${Math.min(72, (hoverIdx! / (points.length - 1)) * 100)}%` }}
        >
          <p className="num text-slate-100">{active.date}</p>
          <p className="num mt-0.5" style={{ color: colorOf(active.nfi) }}>
            NFI {active.nfi ?? '—'}
          </p>
          <p className="num" style={{ color: colorOf(active.crs) }}>
            CRS {active.crs ?? '—'}
          </p>
          {overlay && overlay.values[hoverIdx!] !== null && overlay.values[hoverIdx!] !== undefined && (
            <p className="num" style={{ color: overlay.color }}>
              {overlay.name} {overlay.values[hoverIdx!]}
            </p>
          )}
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 rounded bg-[#3da9fc]" /> NFI
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 rounded bg-[#f5a623]" /> CRS
        </span>
        {overlay && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: overlay.color }} /> {overlay.name}（联动）
          </span>
        )}
        <span className="num ml-auto">共 {points.length} 个快照 · hover 看十字准星</span>
      </div>
    </div>
  )
}
