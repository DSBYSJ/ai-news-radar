import type { Divergence } from '../../types.ts'

/**
 * 背离警示跑马灯（顶部横向滚动）
 *
 * 有告警时：卡片横向无限滚动（hover 暂停），红/琥珀高亮；
 * 无告警时：一行冷静状态，带一个缓慢脉冲的绿点。
 */

const SEVERITY_STYLE = {
  critical: 'border-[#e5484d]/60 bg-[#e5484d]/12 text-[#ff8b8f]',
  warning: 'border-[#f5a623]/50 bg-[#f5a623]/10 text-[#f7c873]',
} as const

export default function RiskTicker({ items }: { items: Divergence[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
        <span className="risk-pulse inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <p className="text-[11px] text-slate-400">
          背离监测正常 · 情绪 / 价格 / 热度 / 融资 / 叙事 / 宏观 暂无异常信号
        </p>
      </div>
    )
  }

  // 内容重复一遍，保证无缝循环
  const doubled = [...items, ...items]

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <div className="ticker-track flex w-max items-stretch gap-2 p-2">
        {doubled.map((d, i) => (
          <div
            key={`${d.type}-${i}`}
            className={`flex w-[340px] shrink-0 flex-col justify-center gap-1 rounded-lg border px-3 py-2 ${SEVERITY_STYLE[d.severity]}`}
          >
            <div className="flex items-center gap-2">
              <span className="rounded bg-black/25 px-1.5 py-0.5 text-[9.5px] font-medium">{d.typeLabel}</span>
              {d.entity && <span className="num text-[10px] opacity-80">{d.entity}</span>}
              <span className="ml-auto text-[9.5px] opacity-70">{d.severity === 'critical' ? '严重' : '提示'}</span>
            </div>
            <p className="truncate text-[11px] font-medium">{d.title}</p>
            <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
              {d.metrics.slice(0, 3).map((m) => (
                <span key={m.label} className="num text-[9.5px] opacity-75">
                  {m.label} {m.value}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* 左右渐隐遮罩 */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[#0d1117] to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#0d1117] to-transparent" />
    </div>
  )
}
