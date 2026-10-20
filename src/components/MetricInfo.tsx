import { useState } from 'react'

/**
 * 指标说明 Tooltip（item 9）
 * 悬停/聚焦时展示该指标的权重构成与计算公式。
 * 数据写死在前端常量里（口径与后端一致，改口径时同步改这里）。
 */

type MetricKey = 'hot' | 'nfi' | 'crs'

const DOCS: Record<MetricKey, { title: string; formula: string; rows: { label: string; weight: string }[]; note: string }> = {
  hot: {
    title: '热度指数',
    formula: 'round( Σ over 独立来源 10 × 0.5^(该来源最新一篇的年龄小时 / 24) )',
    rows: [
      { label: '每个独立来源满分 10 分', weight: '×1' },
      { label: '24 小时半衰（越新越靠前）', weight: '0.5^(age/24)' },
      { label: '同一家连发多篇只算一次', weight: '—' },
      { label: '文章数、信源权重不计入', weight: '—' },
    ],
    note: '含义：48 小时内被几家独立源持续报道 ≈ 10 × 源数。',
  },
  nfi: {
    title: 'NFI 叙事泡沫指数',
    formula: 'Σ(分项得分 × 权重) / Σ权重，分项样本不足时按剩余权重归一',
    rows: [
      { label: '融资/上市密度', weight: '25%' },
      { label: '情绪偏正度', weight: '25%' },
      { label: '叙事集中度（前 5 实体占比）', weight: '20%' },
      { label: '热度加速度', weight: '20%' },
      { label: '亢奋词密度', weight: '10%' },
    ],
    note: '只用站内新闻，衡量「讨论有多热」，不是估值模型。',
  },
  crs: {
    title: 'CRS 危机风险分',
    formula: '0.4×NFI + 0.2×利率 + 0.2×信用 + 0.2×指数（缺宏观则不出分）',
    rows: [
      { label: '叙事过热（NFI）', weight: '40%' },
      { label: '利率压力（10Y 水平 + 一年变化）', weight: '20%' },
      { label: '信用环境（OAS 极窄/走阔取大）', weight: '20%' },
      { label: '指数过热（距 200 日均值 + 一年涨幅）', weight: '20%' },
    ],
    note: '概率 = 12% 基础率 × exp((CRS−50)/28)，±5pp；参数人为设定，未回测。',
  },
}

export default function MetricInfo({ metric, className = '' }: { metric: MetricKey; className?: string }) {
  const [open, setOpen] = useState(false)
  const doc = DOCS[metric]

  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-label={`${doc.title}计算口径`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault()
          setOpen((v) => !v)
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[9px] text-slate-400 transition hover:border-slate-400 hover:text-slate-600 dark:border-white/15 dark:text-slate-500 dark:hover:text-slate-300"
      >
        ?
      </button>

      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-xl border border-[var(--line)] bg-white p-3 text-left shadow-xl dark:bg-[#141821]"
        >
          <span className="block text-[12px] font-semibold text-slate-800 dark:text-slate-100">{doc.title}</span>
          <span className="num mt-1 block rounded bg-slate-50 px-2 py-1 text-[10.5px] leading-relaxed text-slate-600 dark:bg-white/[0.05] dark:text-slate-300">
            {doc.formula}
          </span>
          <span className="mt-2 block space-y-1">
            {doc.rows.map((r) => (
              <span key={r.label} className="flex items-baseline justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span>{r.label}</span>
                <span className="num shrink-0 font-medium text-slate-600 dark:text-slate-300">{r.weight}</span>
              </span>
            ))}
          </span>
          <span className="mt-2 block border-t border-slate-100 pt-1.5 text-[10.5px] leading-relaxed text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
            {doc.note}
          </span>
        </span>
      )}
    </span>
  )
}
