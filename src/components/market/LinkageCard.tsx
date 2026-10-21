import { useEffect, useState } from 'react'
import { api } from '../../api.ts'
import type { EntityClass, LinkageObservation, LinkageResponse, LinkageStat, LinkageStatus } from '../../types.ts'

/**
 * 新闻热度 × 股价：前瞻性观察系统（v0.43.0）
 *
 * 与上一版的区别：不再每次现算覆盖，而是**记录当时知道什么，之后发生了什么**。
 *
 * 页面必须回答四个问题，顺序不能乱：
 *   1. 样本够不够判断？（不够就先说，不给结论）
 *   2. 事件分成了几类？（直接上市 / 产品关联 / 未上市 / 认不出）
 *   3. 结算到哪一步了？（成熟 / 等数据 / 缺行情 / 无法映射）
 *   4. 结果是多少？（T0 与 T+5 分开）
 */

const pct = (v: number | null, digits = 2): string =>
  v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`

const CLASS_LABEL: Record<EntityClass, string> = {
  listed: '直接上市公司',
  product: '产品/品牌（关联母公司）',
  private: '未上市主体',
  unknown: '暂无法确定',
}

const STATUS_LABEL: Record<LinkageStatus, { text: string; tone: string }> = {
  matured: { text: '已成熟', tone: 'text-emerald-600 dark:text-emerald-400' },
  pending: { text: '等待数据', tone: 'text-amber-600 dark:text-amber-400' },
  no_price: { text: '缺行情', tone: 'text-slate-500 dark:text-slate-400' },
  unmapped: { text: '无法映射', tone: 'text-slate-400 dark:text-slate-500' },
}

function StatCard({ title, hint, stat, warn }: { title: string; hint: string; stat: LinkageStat; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50/80 p-2.5 dark:bg-white/[0.03]">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-slate-600 dark:text-slate-300">{title}</span>
        <span className="num text-[9.5px] text-slate-400">N={stat.evaluated}</span>
      </div>
      <p className="mt-0.5 text-[9.5px] text-slate-400">{hint}</p>
      {stat.evaluated === 0 ? (
        <p className="mt-1.5 text-[11px] text-slate-400">暂无可用样本</p>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-[10px] text-slate-400">均值超额</span>
            <span
              className={`num text-[13px] font-semibold ${
                warn ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-200'
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
  const [data, setData] = useState<LinkageResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .marketLinkage()
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

  const { stats, observations, snapshots } = data
  const mappedTotal = stats.mapping.direct + stats.mapping.indirect
  const rate = (n: number): string => (stats.totalEvents > 0 ? `${Math.round((n / stats.totalEvents) * 100)}%` : '—')

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] tracking-[0.12em] text-slate-400">新闻热度 → 股价：前瞻性观察</p>
        <span className="num text-[10px] text-slate-500">
          截止 {stats.asOf} · 行情至 {stats.priceDataUntil ?? '—'}
        </span>
      </div>

      <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500 dark:text-slate-400">
        事件 = 某实体一天内被 <b>≥2 家独立信源</b>报道，首次满足时落库；结果是
        <b>超额收益（个股 − 纳指）</b>。T0 当日可得，T+5 要等 5 个交易日走完 —— 没走完就标「等待数据」，
        绝不当 0 收益。
      </p>

      {/* 1. 样本够不够 */}
      <p
        className={`mt-2 rounded-lg px-2.5 py-1.5 text-[10.5px] leading-relaxed ${
          stats.sufficient
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
        }`}
      >
        {stats.sufficient ? '✓ ' : '⚠️ '}
        {stats.note}
      </p>

      {/* 2. 事件分成了几类 */}
      <div className="mt-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[10.5px] text-slate-500 dark:text-slate-400">事件分类（{stats.totalEvents} 个）</p>
          <p className="num text-[10px] text-slate-400">
            直接映射 {stats.mapping.direct}（{rate(stats.mapping.direct)}）· 间接 {stats.mapping.indirect}（
            {rate(stats.mapping.indirect)}）· 未映射 {stats.mapping.none}（{rate(stats.mapping.none)}）
          </p>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {(Object.keys(CLASS_LABEL) as EntityClass[]).map((k) => (
            <div key={k} className="rounded-lg bg-slate-50/80 px-2 py-1.5 dark:bg-white/[0.03]">
              <p className="truncate text-[9.5px] text-slate-500">{CLASS_LABEL[k]}</p>
              <p className="num text-[12px] text-slate-700 dark:text-slate-200">
                {stats.byClass[k] ?? 0}
                <span className="ml-1 text-[9.5px] text-slate-400">{rate(stats.byClass[k] ?? 0)}</span>
              </p>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[9.5px] leading-relaxed text-slate-400">
          「暂无法确定」是我们<b>没认出来</b>，不等于该主体没有可投资资产 —— 补别名后会变成前两类。
        </p>
      </div>

      {/* 3. 结算进度 */}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
        {(['matured', 'pending', 'no_price', 'unmapped'] as LinkageStatus[]).map((s) => (
          <span key={s} className="text-slate-500 dark:text-slate-400">
            {STATUS_LABEL[s].text}
            <b className={`num ml-1 ${STATUS_LABEL[s].tone}`}>{stats.byStatus[s]}</b>
          </span>
        ))}
        <span className="text-slate-400">（已映射 {mappedTotal} 个）</span>
      </div>

      {/* 4. 结果 */}
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        <StatCard title="当日超额（T0）" hint="事件日相对前一日；可能由新闻本身驱动，不是预测" stat={stats.t0} />
        <StatCard title="事件后 5 个交易日（T+1..T+5）" hint="真正的「之后发生了什么」；窗口未走完不计入" stat={stats.t5} warn />
      </div>

      {stats.concentration && stats.concentration.share >= 0.5 && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          ⚠️ 结果高度集中在 {stats.concentration.symbol}（占 {Math.round(stats.concentration.share * 100)}% 的已成熟样本），
          可能只是单一标的的故事，不代表跨源确认普遍有效。
        </p>
      )}

      {/* 快照趋势 */}
      {snapshots.length > 0 && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[10.5px] text-slate-500 underline decoration-dotted dark:text-slate-400">
            每日快照（{snapshots.length} 天，可复现）
          </summary>
          <div className="mt-1.5 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[9.5px]">
              <thead>
                <tr className="text-slate-500">
                  <th className="py-1 pr-2 text-left font-normal">日期</th>
                  <th className="py-1 px-1.5 text-right font-normal">新增</th>
                  <th className="py-1 px-1.5 text-right font-normal">总数</th>
                  <th className="py-1 px-1.5 text-right font-normal">成熟</th>
                  <th className="py-1 px-1.5 text-right font-normal">等数据</th>
                  <th className="py-1 px-1.5 text-right font-normal">T+5 N</th>
                  <th className="py-1 px-1.5 text-right font-normal">T+5 均值</th>
                  <th className="py-1 pl-1.5 text-left font-normal">版本</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.slice(-6).map((s) => (
                  <tr key={s.date} className="border-t border-slate-100 dark:border-white/[0.06]">
                    <td className="num py-1 pr-2 text-slate-500">{s.date}</td>
                    <td className="num py-1 px-1.5 text-right text-slate-500">{s.newEvents}</td>
                    <td className="num py-1 px-1.5 text-right text-slate-600 dark:text-slate-300">{s.totalEvents}</td>
                    <td className="num py-1 px-1.5 text-right text-emerald-600 dark:text-emerald-400">
                      {s.byStatus.matured}
                    </td>
                    <td className="num py-1 px-1.5 text-right text-amber-600 dark:text-amber-400">{s.byStatus.pending}</td>
                    <td className="num py-1 px-1.5 text-right text-slate-500">{s.t5.evaluated}</td>
                    <td className="num py-1 px-1.5 text-right text-slate-600 dark:text-slate-300">{pct(s.t5.avg)}</td>
                    <td
                      className="py-1 pl-1.5 text-slate-400"
                      title={`算法 ${s.algoVersion} · 映射 ${s.mappingVersion} · 行情至 ${s.priceDataUntil ?? '—'}`}
                    >
                      {s.algoVersion}/{s.mappingVersion}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* 事件明细 */}
      {observations.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10.5px] text-slate-500 underline decoration-dotted dark:text-slate-400">
            事件明细（{observations.length}）
          </summary>
          <div className="mt-1.5 overflow-x-auto">
            <table className="w-full min-w-[620px] text-[10px]">
              <thead>
                <tr className="text-slate-500">
                  <th className="py-1 pr-2 text-left font-normal">日期</th>
                  <th className="py-1 px-1.5 text-left font-normal">实体</th>
                  <th className="py-1 px-1.5 text-left font-normal">标的</th>
                  <th className="py-1 px-1.5 text-right font-normal">源数</th>
                  <th className="py-1 px-1.5 text-right font-normal">T0</th>
                  <th className="py-1 px-1.5 text-right font-normal">T+5</th>
                  <th className="py-1 pl-1.5 text-left font-normal">状态</th>
                </tr>
              </thead>
              <tbody>
                {observations.slice(0, 25).map((o: LinkageObservation) => (
                  <tr key={o.eventId} className="border-t border-slate-100 dark:border-white/[0.06]">
                    <td className="num py-1 pr-2 text-slate-500">{o.eventDate}</td>
                    <td className="py-1 px-1.5 text-slate-600 dark:text-slate-300">{o.entity}</td>
                    <td className="py-1 px-1.5 font-medium text-slate-700 dark:text-slate-200">{o.symbol ?? '—'}</td>
                    <td className="num py-1 px-1.5 text-right text-slate-500">{o.sources}</td>
                    <td
                      className="num py-1 px-1.5 text-right"
                      style={{ color: o.t0Excess === null ? undefined : o.t0Excess >= 0 ? '#e5484d' : '#22c55e' }}
                    >
                      {pct(o.t0Excess)}
                    </td>
                    <td
                      className="num py-1 px-1.5 text-right"
                      style={{ color: o.t5Excess === null ? undefined : o.t5Excess >= 0 ? '#e5484d' : '#22c55e' }}
                    >
                      {pct(o.t5Excess)}
                    </td>
                    <td className={`py-1 pl-1.5 ${STATUS_LABEL[o.status].tone}`} title={o.statusReason ?? undefined}>
                      {STATUS_LABEL[o.status].text}
                      {o.revision > 0 && <span className="ml-1 text-[9px] text-slate-400">r{o.revision}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[9px] leading-relaxed text-slate-400">
            r 编号 = 该事件结果被修订过几次（补录行情或修复映射后重算）。首次发现时间、信源数与当时的映射规则不会随修订改变。
          </p>
        </details>
      )}
    </section>
  )
}
