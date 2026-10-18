import type { SourceItem } from '../types.ts'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../utils/format.ts'

export interface FilterState {
  days: number
  category: string
  source: string
  minScore: number
  q: string
}

interface Props {
  value: FilterState
  onChange: (next: FilterState) => void
  sources: SourceItem[]
}

/** 统一控件外观：白底 + 发丝描边 + 聚焦时紫环，三端（select / input / range）保持一致 */
const ctl =
  'h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 outline-none transition ' +
  'hover:border-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15 ' +
  'dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:border-white/20 dark:focus:border-violet-400'

const label = 'flex flex-col gap-1 text-[10.5px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500'

/**
 * 筛选栏：一行放得下就不换行；窄屏自动折行。
 * 视觉上做成"工具栏"而不是"表单"——标签很小、控件统一高度、右侧留出操作位。
 */
export default function Filters({ value, onChange, sources }: Props) {
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]) => onChange({ ...value, [key]: v })

  return (
    <div className="card flex flex-wrap items-end gap-x-3 gap-y-2.5 p-3.5">
      <label className={label}>
        范围
        <select className={ctl} value={value.days} onChange={(e) => set('days', Number(e.target.value))}>
          <option value={1}>近 1 天</option>
          <option value={3}>近 3 天</option>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </label>

      <label className={label}>
        分类
        <select className={ctl} value={value.category} onChange={(e) => set('category', e.target.value)}>
          <option value="">全部</option>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      <label className={label}>
        来源
        <select className={ctl} value={value.source} onChange={(e) => set('source', e.target.value)}>
          <option value="">全部</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className={label}>
        <span className="flex items-baseline gap-1">
          最低分
          <span className="num text-[11px] font-semibold text-violet-600 dark:text-violet-400">{value.minScore}</span>
        </span>
        <span className="flex h-8 items-center">
          <input
            type="range"
            min={0}
            max={90}
            step={10}
            value={value.minScore}
            onChange={(e) => set('minScore', Number(e.target.value))}
            className="h-1 w-28 cursor-pointer appearance-none rounded-full bg-slate-200 accent-violet-600 dark:bg-white/15"
          />
        </span>
      </label>

      <label className={`${label} min-w-[9rem] flex-1`}>
        关键词
        <span className="relative">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.2-3.2" />
          </svg>
          <input
            className={`${ctl} w-full !pl-8`}
            placeholder="标题或摘要包含…"
            value={value.q}
            onChange={(e) => set('q', e.target.value)}
          />
        </span>
      </label>
    </div>
  )
}
