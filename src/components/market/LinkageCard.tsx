import { useEffect, useState } from 'react'
import { api } from '../../api.ts'
import type { LinkageStat, LinkageSummary } from '../../types.ts'

/**
 * 新闻热度 × 股价联动（v0.42.0）
 *
 * 设计立场：**先把"能不能判断"说清楚，再谈结论。**
 *
 * 当前新闻历史只有约 1 个月，事件窗口要 5 个交易日 → 可评估事件只有个位数。
 * 这种情况下画一条"跨源确认后跑赢大盘"的曲线是很容易的，但那是自欺。
 * 所以这里：
 *   1. 先亮样本量，不足就直接说"不足以判断"
 *   2. 只给均值/胜率，不给"显著""有效"这类词
 *   3. 把"叙事集中在不可交易的主体"这件事单独列出来 —— 这本身就是发现
 */

const pct = (v: number | null, digits = 2): string =>
  v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`

function StatCard({
  title,
  hint,
  stat,
  tone,
}: {
  title: string
  hint: string
  stat: LinkageStat
  tone: 'neutral' | 'warn'
}) {
  const empty = stat.evaluated === 0
  return (
    <div className="rounded-xl bg-slate-50/80 p-2.5 dark:bg-white/[0.03]">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-slate-600 dark:text-slate-300">{title}</span>
        <span className="num text-[9.5px] text-slate-400">N={stat.evaluated}</span>
      </div>
      <p className="mt-0.5 text-[9.5px] text-slate-400">{hint}</p>
      {empty ? (
        <p className="mt-1.5 text-[11px] text-slate-400">暂无可用样本</p>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-[10px] text-slate-400">均值超额</span>
            <span
              className={`num text-[13px] font-semibold ${
                tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-200'
              }`}
            >
              {pct(stat.avg)}
            </span>
          </div>
          <div className="mt-0.5 flex items-baseline justify-between">
            <span className="text-[10px] text-slate-400">中位 / 胜率</span>
            <span className="num text-[11px] text-slate-500 dark:text-slate-400">
              {pct(stat.median)} / {stat.winRate === null ? '—' : `${Math.round(stat.winRate * 100)}%`}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

export default function LinkageCard() {
  const [data, setData] = useState<LinkageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .marketLinkage(60, 2, 5)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [])

  if (error) {
    return (
      <section className="card p-4">
        <p className="text-[11px] text-red-500">联动数据加载失败：{error}</p>
      </section>
    )
  }
  if (!data) return <section className="card h-32 animate-pulse rounded-xl" />

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] tracking-[0.12em] text-slate-400">新闻热度 → 股价：跨源确认之后</p>
        <span className="num text-[10px] text-slate-500">
          新闻 {data.newsFrom} ~ {data.newsTo}
        </span>
      </div>

      <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500 dark:text-slate-400">
        事件 = 某实体在一天内被 <b>≥{data.minSources} 家独立信源</b>报道；结果用
        <b> 超额收益（个股 − 纳指）</b>衡量 —— 否则大盘普涨时所有事件都"有效"，等于没验证。
      </p>

      {/* 样本量提示：不足时最醒目 */}
      <p
        className={`mt-2 rounded-lg px-2.5 py-1.5 text-[10.5px] leading-relaxed ${
          data.sufficient
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
        }`}
      >
        {data.sufficient ? '✓ ' : '⚠️ '}
        {data.note}
      </p>

      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        <StatCard
          title="当日超额（T0）"
          hint="事件日相对前一日；可能由新闻本身驱动，不是预测"
          stat={data.sameDay}
          tone="neutral"
        />
        <StatCard
          title={`事件后 ${data.horizon} 个交易日（T+1..T+${data.horizon}）`}
          hint="真正的「之后发生了什么」；窗口未走完的事件不计入"
          stat={data.forward}
          tone="warn"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-400">
        <span>
          原始事件 <b className="num text-slate-600 dark:text-slate-300">{data.rawEvents}</b>
        </span>
        <span>
          映射到上市标的 <b className="num text-slate-600 dark:text-slate-300">{data.mappedEvents}</b>
        </span>
        <span>
          T+{data.horizon} 可评估 <b className="num text-slate-600 dark:text-slate-300">{data.evaluated}</b>
        </span>
      </div>

      {/* 叙事集中在不可交易的主体 —— 这本身就是结论 */}
      {data.unmappedTop.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-slate-200/70 px-2.5 py-2 dark:border-white/[0.08]">
          <p className="text-[10.5px] text-slate-500 dark:text-slate-400">
            被报道最多、但<b className="text-slate-600 dark:text-slate-300">没有股票可联动</b>的主体：
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {data.unmappedTop.map((u) => (
              <span
                key={u.entity}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 dark:bg-white/[0.06] dark:text-slate-300"
                title={`${u.mentions} 次提及，最多 ${u.sources} 家独立源`}
              >
                {u.entity}
                <span className="num ml-1 opacity-60">{u.mentions}</span>
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-[9.5px] leading-relaxed text-slate-400">
            这说明当前 AI 叙事最集中的主体大多未上市 —— 热度无法直接映射成可交易资产的价格。
          </p>
        </div>
      )}

      {/* 事件明细 */}
      {data.items.length > 0 && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[10.5px] text-slate-500 underline decoration-dotted dark:text-slate-400">
            展开事件明细（{data.items.length}）
          </summary>
          <div className="mt-1.5 overflow-x-auto">
            <table className="w-full min-w-[520px] text-[10px]">
              <thead>
                <tr className="text-slate-500">
                  <th className="py-1 pr-2 text-left font-normal">日期</th>
                  <th className="py-1 px-1.5 text-left font-normal">标的</th>
                  <th className="py-1 px-1.5 text-left font-normal">实体</th>
                  <th className="py-1 px-1.5 text-right font-normal">源数</th>
                  <th className="py-1 px-1.5 text-right font-normal">T0 超额</th>
                  <th className="py-1 pl-1.5 text-right font-normal">T+{data.horizon}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.slice(0, 20).map((e) => (
                  <tr key={`${e.date}-${e.symbol}-${e.entity}`} className="border-t border-slate-100 dark:border-white/[0.06]">
                    <td className="num py-1 pr-2 text-slate-500">{e.date}</td>
                    <td className="py-1 px-1.5 font-medium text-slate-700 dark:text-slate-200">{e.symbol}</td>
                    <td className="py-1 px-1.5 text-slate-500">{e.entity}</td>
                    <td className="num py-1 px-1.5 text-right text-slate-500">{e.sources}</td>
                    <td
                      className="num py-1 px-1.5 text-right"
                      style={{ color: e.sameDayExcess === null ? undefined : e.sameDayExcess >= 0 ? '#e5484d' : '#22c55e' }}
                    >
                      {pct(e.sameDayExcess)}
                    </td>
                    <td
                      className="num py-1 pl-1.5 text-right"
                      style={{ color: e.excessReturn === null ? undefined : e.excessReturn >= 0 ? '#e5484d' : '#22c55e' }}
                      title={e.reason ?? undefined}
                    >
                      {e.excessReturn === null ? '窗口未走完' : pct(e.excessReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}
