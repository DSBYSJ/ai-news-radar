import { bandOf, colorOf, GAUGE_STOPS, RISK_LABEL, type RiskBand } from './riskColors.ts'
import CountUp from './CountUp.tsx'

/**
 * 半环仪表盘（CRS / NFI 共用）
 *
 * 手写 SVG（项目约定不引图表库）：
 *   外圈 = 四段风险色带；进度弧 = 当前分（带辉光）；
 *   指针 = **外圈短标记**（不从圆心画，避免穿过中心数字）；
 *   历史灾难刻度 = 弧上只留小刻度线，文字放到图下图例（避免三个红字互相压）。
 *
 * 性能：辉光用 CSS `filter: drop-shadow`（合成层友好），
 * 不用 SVG feGaussianBlur —— 后者在 WebView 里滚动会掉帧。
 */

interface Props {
  value: number | null
  label: string
  /** 分档徽章（如 "偏热" / "需留意"） */
  bandLabel?: string
  /** 副信息（如 "2,206 条"） */
  sub?: string
  marks?: { score: number; label: string; year: string }[]
  /** 未来 12 个月概率区间（0–100） */
  probability?: { low: number; high: number } | null
  height?: number
}

const CX = 120
const CY = 116
const R_BAND = 86 // 色带半径
const R_BAND_IN = 74

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
  height = 150,
}: Props) {
  const v = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value))
  const band: RiskBand = bandOf(v)
  const color = colorOf(v)
  const valueDeg = v === null ? 180 : 180 - (v / 100) * 180
  const glow = band === 'critical' ? 'drop-shadow(0 0 8px rgba(229,72,77,0.75))' : `drop-shadow(0 0 6px ${color}66)`

  // 当前值标记：只在外圈（不进入中心区）
  const markInner = polar(R_BAND_IN - 2, valueDeg)
  const markOuter = polar(R_BAND - 1, valueDeg)
  const markTip = polar(R_BAND + 6, valueDeg)

  return (
    <div className="mx-auto flex w-full max-w-[250px] flex-col items-center">
      <svg viewBox="0 0 240 136" style={{ height }} className="w-full overflow-visible" role="img" aria-label={`${label} 仪表盘`}>
        {/* 底弧 */}
        <path d={arcPath(R_BAND, 0, 100)} fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="12" strokeLinecap="round" />

        {/* 四段风险色带 */}
        {GAUGE_STOPS.map((s) => (
          <path
            key={s.from}
            d={arcPath(R_BAND, s.from + 0.4, s.to - 0.4)}
            fill="none"
            stroke={s.color}
            strokeWidth="12"
            strokeLinecap="round"
            opacity="0.32"
          />
        ))}

        {/* 进度弧（辉光） */}
        {v !== null && v > 0 && (
          <path
            d={arcPath(R_BAND, 0, v)}
            fill="none"
            stroke={color}
            strokeWidth="12"
            strokeLinecap="round"
            style={{ filter: glow }}
          />
        )}

        {/* 历史灾难刻度：只画小刻度线（文字见图例） */}
        {marks.map((m) => {
          const deg = 180 - (m.score / 100) * 180
          const inner = polar(R_BAND - 7, deg)
          const outer = polar(R_BAND + 1, deg)
          return (
            <line
              key={m.year + m.label}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="rgba(229,72,77,0.75)"
              strokeWidth="1.4"
            />
          )
        })}

        {/* 当前值标记（外圈短线 + 端点），不穿过中心数字 */}
        {v !== null && (
          <g>
            <line
              x1={markInner.x}
              y1={markInner.y}
              x2={markOuter.x}
              y2={markOuter.y}
              stroke={color}
              strokeWidth="4"
              strokeLinecap="round"
              style={{ filter: glow }}
            />
            <circle cx={markTip.x} cy={markTip.y} r="3.4" fill={color} />
          </g>
        )}
      </svg>

      {/* 中心数字：独立一块，位于弧内侧（没有任何指针穿过） */}
      <div className="-mt-6 flex flex-col items-center">
        <span
          className="text-[34px] font-semibold leading-none"
          style={{ color, textShadow: band === 'critical' ? '0 0 18px rgba(229,72,77,0.45)' : 'none' }}
        >
          <CountUp value={v} placeholder="—" />
        </span>
        <span className="mt-1.5 text-[9px] tracking-[0.22em] text-slate-500 dark:text-slate-500">{label}</span>
      </div>

      {/* 字幕区：分档徽章 + 副信息 */}
      <div className="mt-1.5 flex flex-col items-center gap-1">
        {bandLabel && (
          <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ color, backgroundColor: `${color}1f` }}>
            {bandLabel}
          </span>
        )}
        {sub && <span className="num text-[9.5px] text-slate-500 dark:text-slate-500">{sub}</span>}
      </div>

      {/* 历史刻度图例（文字不再压在弧上） */}
      {marks.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5">
          {marks.map((m) => (
            <span key={m.year + m.label} className="num flex items-center gap-1 text-[9px] text-[#e5484d] opacity-85">
              <span className="inline-block h-1.5 w-px bg-[#e5484d] opacity-70" />
              {m.year} {m.label} {m.score}
            </span>
          ))}
        </div>
      )}

      {/* 未来 12 个月概率区间阴影带 */}
      {probability && (
        <div className="mt-2 flex w-full flex-col items-center">
          <div className="relative h-1.5 w-[78%] overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="absolute inset-y-0 rounded-full"
              style={{
                left: `${probability.low}%`,
                width: `${Math.max(2, probability.high - probability.low)}%`,
                backgroundColor: `${color}99`,
              }}
            />
          </div>
          <span className="num mt-1 text-[9.5px] text-slate-500 dark:text-slate-500">
            12 个月情景参考 {probability.low}%–{probability.high}%
            <span className="ml-1 text-slate-600">（非预测概率）</span>
          </span>
        </div>
      )}

      {v === null && (
        <p className="mt-2 text-[10.5px] text-slate-500 dark:text-slate-500">
          {RISK_LABEL[band]} · 数据不足，未计算
        </p>
      )}
    </div>
  )
}
