import { useEffect } from 'react'
import { Sparkline } from './MacroCard.tsx'
import { percentileColor } from './riskColors.ts'

/**
 * 宏观指标下钻抽屉（Click-to-Explain）
 *
 * 点击顶部宏观卡片 → 右侧滑出：近 10 年长周期走势 + 传导逻辑说明。
 * 纯手写 SVG 折线（历史序列按需降采样，避免 5000 点全画）。
 */

interface Props {
  open: boolean
  onClose: () => void
  data: {
    label: string
    display: string
    raw: number
    percentile: number | null
    asOf: string
    /** 全量历史（升序，20 年） */
    history: number[]
    yearAgo: number | null
    avg200: number | null
    high52w: number | null
  } | null
  /** 传导逻辑（按指标 key 提供） */
  transmission: string
}

/** 降采样：最多 max 个点（保留首尾） */
function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values
  const step = values.length / max
  const out: number[] = []
  for (let i = 0; i < max; i++) out.push(values[Math.floor(i * step)])
  out.push(values[values.length - 1])
  return out
}

export default function MacroDrawer({ open, onClose, data, transmission }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !data) return null

  const color = percentileColor(data.percentile)
  const series = downsample(data.history, 400)
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  const W = 560
  const H = 170
  const xOf = (i: number): number => (i / (series.length - 1)) * (W - 8) + 4
  const yOf = (v: number): number => H - 8 - ((v - min) / span) * (H - 20)
  const d = series.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
  const area = `${d} L ${xOf(series.length - 1).toFixed(1)},${H - 8} L ${xOf(0).toFixed(1)},${H - 8} Z`

  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-slate-950/60" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-[520px] flex-col overflow-y-auto border-l border-white/10 bg-[#0d1117] p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${data.label} 下钻`}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] tracking-[0.12em] text-slate-500">指标下钻</p>
            <h3 className="mt-1 text-[17px] font-medium text-slate-100">{data.label}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-slate-400 transition hover:border-white/25 hover:text-slate-200"
          >
            关闭
          </button>
        </header>

        <div className="mt-4 flex items-end gap-4">
          <div>
            <p className="num text-[30px] font-semibold leading-none" style={{ color }}>
              {data.display}
            </p>
            <p className="num mt-1 text-[10px] text-slate-500">截至 {data.asOf}</p>
          </div>
          <div className="num space-y-1 text-[10.5px] text-slate-400">
            <p>历史分位 {data.percentile !== null ? `${(data.percentile * 100).toFixed(0)}%` : '—'}</p>
            {data.yearAgo !== null && <p>一年前 {data.yearAgo}</p>}
            {data.avg200 !== null && <p>200 日均值 {data.avg200.toFixed(0)}</p>}
            {data.high52w !== null && <p>52 周高点 {data.high52w.toFixed(0)}</p>}
          </div>
        </div>

        {/* 长周期走势 */}
        <div className="mt-5">
          <p className="text-[10px] tracking-[0.12em] text-slate-500">长周期走势（近 10 年）</p>
          <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
              <defs>
                <linearGradient id="macroArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.32" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={area} fill="url(#macroArea)" />
              <path d={d} fill="none" stroke={color} strokeWidth="1.6" />
              <circle cx={xOf(series.length - 1)} cy={yOf(series[series.length - 1])} r="3" fill={color} />
            </svg>
            <div className="num mt-1 flex justify-between text-[9px] text-slate-500">
              <span>{min.toFixed(2)}</span>
              <span>{max.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* 传导逻辑 */}
        <div className="mt-5">
          <p className="text-[10px] tracking-[0.12em] text-slate-500">对 AI 行业估值 / 融资压力的传导逻辑</p>
          <p className="mt-2 text-[12px] leading-[1.9] text-slate-300">{transmission}</p>
        </div>

        {/* 近 30 天迷你图（对照） */}
        <div className="mt-5">
          <p className="text-[10px] tracking-[0.12em] text-slate-500">近 30 天（对照）</p>
          <div className="mt-1 flex justify-start">
            <Sparkline values={data.history.slice(-30)} width={220} height={44} color={color} />
          </div>
        </div>
      </aside>
    </div>
  )
}

/** 各指标的传导逻辑文案 */
export const TRANSMISSION: Record<string, string> = {
  rates10y:
    '利率是资产定价的分母。10 年期美债收益率上行 → 长久期资产（成长股、AI 公司）的折现值下降 → 二级市场估值锚下移 → 传导至一级市场：融资轮次估值压缩、IPO 窗口收窄、投资人要求更高的风险补偿。当利率处于历史高分位时（如当前 20 年 100% 分位），每一单位的叙事乐观都更难兑现成估值。',
  creditSpread:
    '高收益债信用利差（OAS）是市场对违约风险的要价。利差走阔 → 高收益融资成本上升 → 中小 AI 公司再融资困难、现金流趋紧 → 被迫降价出售资产或接受苛刻条款。相反，利差极窄则意味着市场自满（对风险定价不足），历史上这类阶段往往出现在情绪顶部。',
  nasdaq:
    '纳指是 AI 权重股的情绪温度计。指数下跌 → 二级市场对 AI 的估值锚下移 → 一级市场估值跟着压缩（一二级市场估值倒挂会被快速抹平）；连续下跌会触发整体风险偏好收缩，融资节奏放缓、裁员与整合增加。距 200 日均值越高、一年涨幅越大，回调时的脆弱性越强。',
  rates2y:
    '短端利率反映流动性与政策预期。2 年期高于 10 年期（收益率曲线倒挂）历史上常被视为衰退前瞻信号：资金成本上升、长端增长预期下修，通常伴随后续的信用收紧与估值下杀。',
}
