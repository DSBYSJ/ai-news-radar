import { bandOf, colorOf, GAUGE_STOPS, RISK_LABEL, type RiskBand } from './riskColors.ts'
import CountUp from './CountUp.tsx'

/**
 * 半环仪表盘（CRS / NFI 共用）
 *
 * 手写 SVG（项目约定不引图表库）：
 *   外圈 = 四段风险色带；内弧 = 当前分（带辉光）；指针指向当前值；
 *   可选：历史灾难刻度（2008/2020/2023）与未来 12 个月概率区间阴影带。
 *
 * 性能：辉光用 CSS `filter: drop-shadow`（合成层友好），
 * 不用 SVG feGaussianBlur —— 后者在 WebView 里滚动会掉帧。
 */

interface Props {
  value: number | null
  label: string
  /** 中心副标题（如 "偏热" / "需留意"） */
  bandLabel?: string
  /** 中心底部小字（如 "2,206 条"） */
  sub?: string
  marks?: { score: number; label: string; year: string }[]
  /** 未来 12 个月概率区间（0–100） */
  probability?: { low: number; high: number } | null
  height?: number
}

const CX = 120
const CY = 118
const R_OUT = 96
const R_IN = 82

function polar(r: number, deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) }
}

function arcPath(r: number, fromScore: number, toScore: number): string {
  const start = 180 - (fromScore / 100) * 180
  const end = 180 - (toScore / 100) * 180
  const s = polar(r, start)
  const e = polar(r, end)
  const large = Math.abs(start - end) > 180 ? 1 : 0
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`
}

export default function GaugeArc({
  value,
  label,
  bandLabel,
  sub,
  marks = [],
  probability = null,
  height = 168,
}: Props) {
  const v = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value))
  const band: RiskBand = bandOf(v)
  const color = colorOf(v)
  const needleDeg = v === null ? 180 : 180 - (v / 100) * 180
  const needle = polar(R_IN - 6, needleDeg)
  const glow = band === 'critical' ? 'drop-shadow(0 0 8px rgba(229,72,77,0.75))' : `drop-shadow(0 0 6px ${color}66)`

  return (
    <div className="relative mx-auto w-full max-w-[300px]">
      <svg viewBox="0 0 240 152" style={{ height }} className="w-full overflow-visible" role="img" aria-label={`${label} 仪表盘`}>
        {/* 底弧 */}
        <path d={arcPath(R_IN + 7, 0, 100)} fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="13" strokeLinecap="round" />

        {/* 四段风险色带 */}
        {GAUGE_STOPS.map((s) => (
          <path
            key={s.from}
            d={arcPath(R_IN + 7, s.from + 0.4, s.to - 0.4)}
            fill="none"
            stroke={s.color}
            strokeWidth="13"
            strokeLinecap="round"
            opacity="0.32"
          />
        ))}

        {/* 进度弧（辉光） */}
        {v !== null && v > 0 && (
          <path
            d={arcPath(R_IN + 7, 0, v)}
            fill="none"
            stroke={color}
            strokeWidth="13"
            strokeLinecap="round"
            style={{ filter: glow }}
          />
        )}

        {/* 历史灾难刻度 */}
        {marks.map((m) => {
          const deg = 180 - (m.score / 100) * 180
          const inner = polar(R_OUT + 2, deg)
          const outer = polar(R_OUT + 11, deg)
          const text = polar(R_OUT + 15, deg)
          return (
            <g key={m.year + m.label}>
              <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="rgba(229,72,77,0.8)" strokeWidth="1.4" />
              <text
                x={text.x}
                y={text.y - 3}
                textAnchor={deg > 100 ? 'end' : deg < 80 ? 'start' : 'middle'}
                className="fill-[#e5484d]"
                style={{ fontSize: 8 }}
              >
                {m.year}
              </text>
              <text
                x={text.x}
                y={text.y + 7}
                textAnchor={deg > 100 ? 'end' : deg < 80 ? 'start' : 'middle'}
                className="fill-[#e5484d] opacity-80"
                style={{ fontSize: 7 }}
              >
                {m.label}
              </text>
            </g>
          )
        })}

        {/* 指针：只画外半段（起点在 R_IN*0.55），不穿过中心数字区 */}
        {v !== null && (
          <g>
            {(() => {
              const tail = polar(R_IN * 0.55, needleDeg)
              return (
                <line
                  x1={tail.x}
                  y1={tail.y}
                  x2={needle.x}
                  y2={needle.y}
                  stroke={color}
                  strokeWidth="3"
                  strokeLinecap="round"
                  style={{ filter: glow }}
                />
              )
            })()}
            <circle cx={needle.x} cy={needle.y} r="3.2" fill={color} />
          </g>
        )}
      </svg>

      {/* 中心数字：只放「数值 + 单位」，位置在弧顶下方，避开指针轴心 */}
      <div className="pointer-events-none absolute inset-x-0 top-[26%] flex flex-col items-center">
        <span
          className="text-[36px] font-semibold leading-none"
          style={{ color, textShadow: band === 'critical' ? '0 0 18px rgba(229,72,77,0.5)' : 'none' }}
        >
          <CountUp value={v} placeholder="—" />
        </span>
        <span className="mt-1.5 text-[9px] tracking-[0.22em] text-slate-500">{label}</span>
      </div>

      {/* 字幕区：分档徽章 + 副信息（统一放在图下，避免压住轴心） */}
      <div className="mt-1 flex flex-col items-center gap-1">
        {bandLabel && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px]"
            style={{ color, backgroundColor: `${color}1f` }}
          >
            {bandLabel}
          </span>
        )}
        {sub && <span className="num text-[9.5px] text-slate-500">{sub}</span>}
      </div>

      {/* 未来 12 个月概率区间阴影带 */}
      {probability && (
        <div className="mt-1.5 flex flex-col items-center">
          <div className="relative h-1.5 w-[70%] overflow-hidden rounded-full bg-slate-800">
            <div
              className="absolute inset-y-0 rounded-full"
              style={{
                left: `${probability.low}%`,
                width: `${Math.max(2, probability.high - probability.low)}%`,
                backgroundColor: `${color}80`,
              }}
            />
          </div>
          <span className="num mt-1 text-[9.5px] text-slate-500">
            未来 12 个月概率 {probability.low}%–{probability.high}%
          </span>
        </div>
      )}

      {v === null && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="mt-8 text-[11px] text-slate-500">{RISK_LABEL[band]} · 数据不足</span>
        </div>
      )}
    </div>
  )
}
