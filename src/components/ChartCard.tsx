import type { ReactNode } from 'react'

interface Props {
  level: string
  title: string
  hint?: string
  badge?: ReactNode
  children: ReactNode
}

/** 图表卡片：紫色层级标签 + 标题 + 可选右侧徽章 + 注释小字 */
export default function ChartCard({ level, title, hint, badge, children }: Props) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-medium text-white">{level}</span>
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        {badge && <span className="ml-auto">{badge}</span>}
        {hint && <p className="w-full text-xs leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p>}
      </header>
      {children}
    </section>
  )
}
