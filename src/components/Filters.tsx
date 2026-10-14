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

const inputCls =
  'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none transition ' +
  'focus:border-violet-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:focus:border-violet-400'

const labelCls = 'flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400'

export default function Filters({ value, onChange, sources }: Props) {
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]) => onChange({ ...value, [key]: v })

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
      <label className={labelCls}>
        时间范围
        <select className={inputCls} value={value.days} onChange={(e) => set('days', Number(e.target.value))}>
          <option value={1}>近 1 天</option>
          <option value={3}>近 3 天</option>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </label>

      <label className={labelCls}>
        分类
        <select className={inputCls} value={value.category} onChange={(e) => set('category', e.target.value)}>
          <option value="">全部</option>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      <label className={labelCls}>
        来源
        <select className={inputCls} value={value.source} onChange={(e) => set('source', e.target.value)}>
          <option value="">全部</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className={labelCls}>
        最低分 {value.minScore}
        <input
          type="range"
          min={0}
          max={90}
          step={10}
          value={value.minScore}
          onChange={(e) => set('minScore', Number(e.target.value))}
          className="w-32 accent-violet-600"
        />
      </label>

      <label className={labelCls}>
        关键词
        <input
          className={inputCls}
          placeholder="标题或摘要包含"
          value={value.q}
          onChange={(e) => set('q', e.target.value)}
        />
      </label>
    </div>
  )
}
