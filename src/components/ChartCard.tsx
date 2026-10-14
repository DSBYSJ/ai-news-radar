import type { ReactNode } from 'react'

interface Props {
  level: string
  title: string
  hint?: string
  badge?: ReactNode
  children: ReactNode
}

export default function ChartCard({ level, title, hint, badge, children }: Props) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded bg-slate-900 px-2 py-0.5 text-xs font-medium text-white">{level}</span>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {badge}
        {hint && <p className="w-full text-xs text-slate-500">{hint}</p>}
      </header>
      {children}
    </section>
  )
}
