import type { Edition, EditionItem } from '../types.ts'

/** 引用：AIHOT 的日报版式给了很大启发（头条 / 分区 / 快讯），本项目按其思路重写，未复制其代码 */

function CatChip({ category, label }: { category: string; label: string }) {
  const color: Record<string, string> = {
    model_release: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
    product_update: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
    research_paper: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
    open_source: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    funding: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    policy: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
    opinion: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
    other: 'bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-300',
  }
  return <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${color[category] ?? color.other}`}>{label}</span>
}

function TrustBadge({ weight }: { weight: number }) {
  if (weight >= 3) {
    return (
      <span className="shrink-0 rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium text-white">一手</span>
    )
  }
  if (weight <= 1) {
    return (
      <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-white/5 dark:text-slate-400">
        聚合
      </span>
    )
  }
  return null
}

function CrossBadge({ count }: { count: number }) {
  if (count < 2) return null
  return (
    <span className="shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:bg-red-500/15 dark:text-red-300">
      另外 {count - 1} 家也报道了
    </span>
  )
}

function SourceMeta({ item }: { item: EditionItem }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-slate-400 dark:text-slate-500">
      <span className="text-slate-500 dark:text-slate-400">{item.sourceName}</span>
      <TrustBadge weight={item.sourceWeight} />
      <CrossBadge count={item.sourceCount} />
    </span>
  )
}

/**
 * 结构化日报版面：导语（AI 综述，可折叠）+ 头条 + 分类分区 + 快讯。
 * 与 AIHOT 的差别：只在同日聚类、不做跨天后续进展、不产出公开页面（合规）。
 */
export default function EditionView({ edition }: { edition: Edition }) {
  const { headline, sections, flash, brief, stats } = edition
  const empty = !headline && sections.length === 0 && flash.length === 0

  if (empty) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
        这一天还没有入库条目（采集是每天 07/10/13/17/21 五个时间点，当天可能还没跑到）。
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* 统计行 */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="num rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-white/5 dark:text-slate-300">
          共 {stats.total} 条
        </span>
        {stats.crossSource > 0 && (
          <span className="num rounded-full bg-red-50 px-2 py-0.5 text-red-600 dark:bg-red-500/15 dark:text-red-300">
            跨源事件 {stats.crossSource}
          </span>
        )}
        {brief && (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
            {brief.model === 'statistical' ? '统计版综述' : 'AI 综述'}
          </span>
        )}
      </div>

      {/* 导语 */}
      {brief && (
        <details className="group rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <span className="min-w-0 flex-1 truncate">今日综述 · {brief.title}</span>
            <span className="shrink-0 text-[10px] text-slate-400 group-open:hidden">展开 ▾</span>
            <span className="hidden shrink-0 text-[10px] text-slate-400 group-open:inline">收起 ▴</span>
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {brief.content}
          </pre>
        </details>
      )}

      {/* 头条 */}
      {headline && (
        <article className="card card-accent relative overflow-hidden p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-white dark:bg-white dark:text-slate-900">
              头条
            </span>
            <CatChip category={headline.category} label={edition.sections.find((s) => s.category === headline.category)?.label ?? headline.category} />
            {headline.sourceCount >= 2 && (
              <span className="num rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white">
                {headline.sourceCount} 家独立源
              </span>
            )}
          </div>
          <h4 className="mt-2 text-[15px] font-semibold leading-snug text-slate-900 dark:text-white">
            <a href={headline.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {headline.title}
            </a>
          </h4>
          {(headline.summary || headline.tldr) && (
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {headline.summary || headline.tldr}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SourceMeta item={headline} />
            <a
              href={headline.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-[10px] text-slate-400 hover:text-slate-600 hover:underline dark:hover:text-slate-300"
            >
              原文 ↗
            </a>
          </div>
        </article>
      )}

      {/* 分类分区 */}
      {sections.map((section, idx) => (
        <section key={section.category}>
          <header className="mb-2 flex items-baseline gap-2">
            <span className="num text-[11px] font-semibold text-violet-600 dark:text-violet-300">
              {String(idx + 1).padStart(2, '0')}
            </span>
            <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{section.label}</h4>
            <span className="num text-[10px] text-slate-400">{section.items.length} 件</span>
          </header>
          <ul className="space-y-2.5">
            {section.items.map((it) => (
              <li key={it.id} className="border-l-2 border-slate-100 pl-3 dark:border-white/10">
                <a
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] font-medium leading-snug text-slate-800 hover:text-violet-700 hover:underline dark:text-slate-100 dark:hover:text-violet-300"
                >
                  {it.title}
                </a>
                {(it.summary || it.tldr) && (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    {it.summary || it.tldr}
                  </p>
                )}
                <div className="mt-1">
                  <SourceMeta item={it} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* 快讯 */}
      {flash.length > 0 && (
        <section>
          <header className="mb-2 flex items-baseline gap-2">
            <span className="num text-[11px] font-semibold text-violet-600 dark:text-violet-300">
              {String(sections.length + 1).padStart(2, '0')}
            </span>
            <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">快讯</h4>
            <span className="num text-[10px] text-slate-400">{flash.length} 条</span>
          </header>
          <ul className="space-y-1.5">
            {flash.map((it) => (
              <li key={it.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                <span className="mt-0.5 shrink-0 text-slate-300 dark:text-slate-600">·</span>
                <a
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 break-words text-slate-600 hover:text-slate-900 hover:underline dark:text-slate-300 dark:hover:text-white"
                >
                  {it.title}
                </a>
                <span className="shrink-0 text-[10px] text-slate-400">{it.sourceName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
