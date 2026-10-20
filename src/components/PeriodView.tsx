import type { PeriodReport } from '../types.ts'

/** 周报 / 月报：确定性统计汇编（数字来自库内，不调模型） */
export default function PeriodView({ report }: { report: PeriodReport }) {
  const { totals, categories, topEvents, topEntities, bursts, highlights, kind, partial, daysElapsed, deltaNote } = report
  const spanDays = kind === 'week' ? 7 : new Date(Date.UTC(Number(report.end.slice(0, 4)), Number(report.end.slice(5, 7)), 0)).getUTCDate()
  const maxShare = Math.max(...categories.map((c) => c.share), 0.0001)

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="num text-sm font-semibold text-slate-900 dark:text-slate-100">{report.label}</span>
        <span className="num text-[11px] text-slate-400 dark:text-slate-500">
          {report.start} ~ {report.end} · {kind === 'week' ? '周报' : '月报'}
        </span>
        {partial && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
            进行中 {daysElapsed}/{spanDays} 天
          </span>
        )}
      </div>

      {/* 四个关键数字 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: '收录', value: String(totals.articles), hint: '' },
          {
            label: '日均',
            value: totals.perDay.toFixed(1),
            hint: deltaNote ?? (totals.deltaPct === null ? '上期无数据' : `环比 ${totals.deltaPct >= 0 ? '↑' : '↓'}${Math.abs(totals.deltaPct)}%`),
          },
          { label: '跨源事件', value: String(totals.crossEvents), hint: '多家独立源' },
          { label: '突发', value: String(totals.bursts), hint: 'z ≥ 2.5' },
        ].map((s) => (
          <div key={s.label} className="card card-accent relative overflow-hidden p-3">
            <p className="eyebrow text-[10px] text-slate-500 dark:text-slate-400">{s.label}</p>
            <p className="num mt-1 text-xl font-semibold leading-none text-slate-900 dark:text-white">{s.value}</p>
            {s.hint && <p className="mt-1 truncate text-[10px] text-slate-400 dark:text-slate-500">{s.hint}</p>}
          </div>
        ))}
      </div>

      {/* 要点 */}
      <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3">
        <p className="eyebrow mb-1.5 text-[10px] text-slate-500 dark:text-slate-400">本期要点</p>
        <ul className="space-y-1">
          {highlights.map((h, i) => (
            <li key={i} className="flex gap-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              <span className="mt-0.5 shrink-0 text-violet-500">·</span>
              <span className="min-w-0 break-words">{h}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 分类结构 */}
      {categories.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5 text-[10px] text-slate-500 dark:text-slate-400">分类结构</p>
          <ul className="space-y-1.5">
            {categories.map((c) => (
              <li key={c.category} className="flex items-center gap-2 text-[11px]">
                <span className="w-16 shrink-0 truncate text-slate-600 dark:text-slate-300">{c.label}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/5">
                  <span
                    className="block h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500"
                    style={{ width: `${Math.max(4, (c.share / maxShare) * 100)}%` }}
                  />
                </span>
                <span className="num w-16 shrink-0 text-right text-slate-500 dark:text-slate-400">
                  {c.count} · {Math.round(c.share * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 跨源事件榜 */}
      {topEvents.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5 text-[10px] text-slate-500 dark:text-slate-400">跨源事件榜（被多家独立源印证）</p>
          <ul className="space-y-1.5">
            {topEvents.map((e, i) => (
              <li key={`${e.date}-${i}`} className="flex items-start gap-2 text-[11px] leading-relaxed">
                <span className="num w-4 shrink-0 text-slate-300 dark:text-slate-600">{i + 1}</span>
                <span className="min-w-0 flex-1 break-words text-slate-700 dark:text-slate-200">{e.title}</span>
                <span className="num shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] text-red-600 dark:bg-red-500/15 dark:text-red-300">
                  {e.sourceCount} 源
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 实体 + 突发 */}
      <div className="grid gap-3 sm:grid-cols-2">
        {topEntities.length > 0 && (
          <div>
            <p className="eyebrow mb-1.5 text-[10px] text-slate-500 dark:text-slate-400">高频实体</p>
            <div className="flex flex-wrap gap-1.5">
              {topEntities.map((e) => (
                <span
                  key={e.name}
                  className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-slate-600 dark:text-slate-300"
                >
                  {e.name} <span className="num text-slate-400 dark:text-slate-500">{e.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {bursts.length > 0 && (
          <div>
            <p className="eyebrow mb-1.5 text-[10px] text-slate-500 dark:text-slate-400">突发明细</p>
            <ul className="space-y-1">
              {bursts.map((b) => (
                <li key={`${b.date}-${b.category}`} className="num flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                  <span className="shrink-0 text-slate-400">{b.date.slice(5)}</span>
                  <span className="shrink-0">{b.category === 'all' ? '全站' : b.category}</span>
                  <span className="shrink-0">{b.count} 条</span>
                  <span className="shrink-0 text-red-500 dark:text-red-300">z={b.z}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
