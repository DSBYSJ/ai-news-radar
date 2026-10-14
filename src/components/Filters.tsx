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

export default function Filters({ value, onChange, sources }: Props) {
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]) => onChange({ ...value, [key]: v })

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <label className="flex flex-col gap-1 text-xs text-slate-500">
        时间范围
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={value.days}
          onChange={(e) => set('days', Number(e.target.value))}
        >
          <option value={1}>近 1 天</option>
          <option value={3}>近 3 天</option>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-500">
        分类
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={value.category}
          onChange={(e) => set('category', e.target.value)}
        >
          <option value="">全部</option>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-500">
        来源
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={value.source}
          onChange={(e) => set('source', e.target.value)}
        >
          <option value="">全部</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-500">
        最低分 {value.minScore}
        <input
          type="range"
          min={0}
          max={90}
          step={10}
          value={value.minScore}
          onChange={(e) => set('minScore', Number(e.target.value))}
          className="w-32"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-500">
        关键词
        <input
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          placeholder="标题或摘要包含"
          value={value.q}
          onChange={(e) => set('q', e.target.value)}
        />
      </label>
    </div>
  )
}
