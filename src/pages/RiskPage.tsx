import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { Divergence, RiskFactorV2, RiskReport, VulnerableEntity } from '../types.ts'
import MetricInfo from '../components/MetricInfo.tsx'
import WaterfallChart from '../components/WaterfallChart.tsx'
import RiskHistoryChart from '../components/RiskHistoryChart.tsx'

const BAND_TEXT: Record<string, { label: string; hint: string }> = {
  calm: { label: '冷静', hint: '叙事没有明显过热：融资话题占比低、情绪不偏、关注点分散。' },
  warm: { label: '偏热', hint: '叙事开始集中与加速：值得留意，但还谈不上泡沫。' },
  hot: { label: '过热', hint: '钱的话题占据版面、情绪明显偏正、关注高度集中——历史上这类组合常出现在情绪高点附近。' },
  unknown: { label: '样本不足', hint: '近窗口内条目太少，不计算指数（宁可不给数，也不给假数）。' },
}

const LEVEL_TEXT: Record<string, string> = {
  low: '低',
  guarded: '需留意',
  elevated: '偏高',
  high: '高',
}

function barColor(score: number | null): string {
  if (score === null) return 'var(--line)'
  if (score >= 65) return 'var(--hot)'
  if (score >= 38) return '#b8873a'
  return 'var(--accent)'
}

function FactorRow({ f }: { f: RiskFactorV2 }) {
  return (
    <li className="py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-slate-700 dark:text-slate-200">{f.label}</span>
        <span className="num text-[11px] text-slate-400 dark:text-slate-500">
          {f.score} 分 · 权重 {f.weight}% → 贡献 {f.contribution}
        </span>
        <span className="num ml-auto text-[11px] text-slate-400 dark:text-slate-500">
          {f.value === null ? '—' : f.value}
          {f.percentile !== null ? `（分位 ${(f.percentile * 100).toFixed(0)}%）` : ''}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.07]">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${f.score}%`, backgroundColor: barColor(f.score) }}
        />
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-slate-400 dark:text-slate-500">{f.note}</p>
    </li>
  )
}

/** 背离预警卡片（item 5） */
function DivergenceCard({ d }: { d: Divergence }) {
  const critical = d.severity === 'critical'
  return (
    <div
      className={`rounded-xl border p-3 ${
        critical
          ? 'border-red-300 bg-red-50/70 dark:border-red-500/30 dark:bg-red-950/25'
          : 'border-amber-300 bg-amber-50/70 dark:border-amber-500/25 dark:bg-amber-950/20'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${
            critical ? 'bg-red-600' : 'bg-amber-500'
          }`}
        >
          {d.typeLabel}
        </span>
        <span className="text-[12.5px] font-medium text-slate-800 dark:text-slate-100">{d.title}</span>
        {d.entity && (
          <span className="num rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-white">{d.entity}</span>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">{d.detail}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {d.metrics.map((m) => (
          <span key={m.label} className="num text-[10.5px] text-slate-500 dark:text-slate-400">
            {m.label} {m.value}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 脆弱实体（item 6） */
function VulnerableList({ items }: { items: VulnerableEntity[] }) {
  if (items.length === 0) return null
  return (
    <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
      {items.map((v) => (
        <li key={v.entity} className="flex items-center gap-2 py-2 text-[12px]">
          <span className="num w-8 shrink-0 rounded bg-slate-100 px-1 text-center text-[10.5px] font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-300">
            {v.score}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-slate-700 dark:text-slate-200">{v.entity}</span>
          <span className="num shrink-0 text-[10.5px] text-slate-400">
            负面 {v.negative}/{v.mentions}
            {v.heatChange !== null && ` · 热度 ${v.heatChange > 0 ? '+' : ''}${(v.heatChange * 100).toFixed(0)}%`}
          </span>
          <span className="hidden shrink-0 text-[10.5px] text-slate-400 sm:block">{v.reason}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * AI 估值与金融危机风险（独立模块，v0.26.0）
 *
 * 展示顺序刻意如此：先「有没有异常信号」（背离看板）→ 再「分数怎么来的」（瀑布图）
 * → 再「落到谁身上」（脆弱实体）→ 最后「历史上准不准」（回溯）。
 */
export default function RiskPage() {
  const [days, setDays] = useState(30)
  const [report, setReport] = useState<RiskReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .risk(days)
      .then((r) => {
        if (!alive) return
        setReport(r)
        setError(null)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [days])

  const nfi = report?.nfi
  const band = BAND_TEXT[nfi?.band ?? report?.narrative.band ?? 'unknown']
  const formulaOf = (key: string): string => report?.formulas.find((f) => f.key === key)?.formula ?? ''

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-[var(--accent)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            独立模块 · 只读、不影响其它功能
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            AI 估值与危机风险
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            叙事泡沫指数（NFI）用站内新闻算；危机风险分（CRS）必须接利率/信用利差/指数，缺数据就不出概率。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {[30, 60, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-lg px-2.5 py-1 text-[11px] transition ${
                days === d
                  ? 'bg-[var(--accent)] text-white'
                  : 'border border-[var(--line)] text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {d} 天
            </button>
          ))}
        </div>
      </header>

      {loading && <div className="card h-40 animate-pulse" />}
      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
      )}

      {/* ===== 背离预警（置顶） ===== */}
      {report && report.divergences.length > 0 && (
        <section className="space-y-2">
          <p className="eyebrow flex items-center gap-1.5 text-[10px] text-[var(--hot)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--hot)]" />
            背离预警 · {report.divergences.length} 条
          </p>
          {report.divergences.map((d) => (
            <DivergenceCard key={d.type} d={d} />
          ))}
        </section>
      )}

      {/* ===== 宏观读数 ===== */}
      {report && Object.keys(report.macro.series).length > 0 && (
        <div className="grid gap-2 sm:grid-cols-4">
          {Object.values(report.macro.series)
            .filter((s) => s.key !== 'rates2y')
            .map((s) => (
              <div key={s.key} className="rounded-lg bg-slate-50/80 p-2.5 dark:bg-white/[0.03]">
                <p className="text-[10px] text-slate-400 dark:text-slate-500">{s.label}</p>
                <p className="num mt-0.5 text-[15px] font-semibold text-slate-800 dark:text-slate-100">
                  {s.key === 'nasdaq' ? s.value.toFixed(0) : `${s.value.toFixed(2)}%`}
                </p>
                <p className="num mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                  {s.yearAgo === null
                    ? `截至 ${s.asOf}`
                    : `一年前 ${s.key === 'nasdaq' ? s.yearAgo.toFixed(0) : `${s.yearAgo.toFixed(2)}%`}`}
                </p>
              </div>
            ))}
          {report.macro.inversion !== null && (
            <div className="rounded-lg bg-slate-50/80 p-2.5 dark:bg-white/[0.03]">
              <p className="text-[10px] text-slate-400 dark:text-slate-500">收益率曲线</p>
              <p
                className={`mt-0.5 text-[15px] font-semibold ${
                  report.macro.inversion ? 'text-[var(--hot)]' : 'text-slate-800 dark:text-slate-100'
                }`}
              >
                {report.macro.inversion ? '倒挂' : '正常'}
              </p>
              <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">2Y vs 10Y</p>
            </div>
          )}
        </div>
      )}

      {/* ===== 叙事泡沫指数 ===== */}
      {report && (
        <section className="card card-accent p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                叙事泡沫指数 NFI
                <MetricInfo metric="nfi" />
                <span className="cursor-help text-[10px] text-slate-400 underline decoration-dotted" title={formulaOf('nfi')}>
                  公式
                </span>
              </p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="num text-[34px] font-semibold leading-none" style={{ color: barColor(nfi?.score ?? null) }}>
                  {nfi?.score ?? '—'}
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-white/10 dark:text-slate-300">
                  {band.label}
                </span>
              </div>
              <p className="mt-2 max-w-[52ch] text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                {band.hint}
              </p>
            </div>
            <div className="num shrink-0 text-right text-[11px] text-slate-400 dark:text-slate-500">
              <p>窗口 {report.windowDays} 天</p>
              <p className="mt-0.5">{report.narrative.articles} 条入库</p>
              <p className="mt-0.5">情感判定 {report.narrative.classified} 条</p>
            </div>
          </div>

          <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
            {(nfi?.factors ?? []).map((f) => (
              <li key={f.key} className="py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium text-slate-700 dark:text-slate-200">{f.label}</span>
                  <span className="num text-[11px] text-slate-400 dark:text-slate-500">
                    {f.score === null ? '未参与' : `${f.score}`} × {f.weight}%
                  </span>
                  <span className="num ml-auto text-[11px] text-slate-400 dark:text-slate-500">
                    {f.value === null ? '—' : f.value}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.07]">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{ width: `${f.score ?? 0}%`, backgroundColor: barColor(f.score) }}
                  />
                </div>
                <p className="mt-1 text-[10.5px] leading-relaxed text-slate-400 dark:text-slate-500">{f.note}</p>
              </li>
            ))}
          </ul>

          {nfi && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
              <span className="cursor-help underline decoration-dotted" title={formulaOf('fomo')}>
                FOMO 系数 {nfi.fomo.score}
              </span>
              {nfi.fomo.hits.length > 0 && <span className="num">命中：{nfi.fomo.hits.join('、')}</span>}
              <span className="num">感叹号密度 {nfi.fomo.exclaimDensity}/百字</span>
            </p>
          )}
        </section>
      )}

      {/* ===== 危机风险分 + 瀑布图 ===== */}
      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="eyebrow flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
            危机风险分 CRS
            <MetricInfo metric="crs" />
            <span className="cursor-help text-[10px] text-slate-400 underline decoration-dotted" title={formulaOf('crs')}>
              公式
            </span>
          </p>
          <p className="text-[10.5px] text-slate-400 dark:text-slate-500">未来 12 个月</p>
        </div>

        {report?.crisis ? (
          <>
            <div className="mt-1 flex flex-wrap items-baseline gap-3">
              <span className="num text-[34px] font-semibold leading-none" style={{ color: barColor(report.crisis.score) }}>
                {report.crisis.score}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-white/10 dark:text-slate-300">
                {LEVEL_TEXT[report.crisis.level] ?? report.crisis.level}
              </span>
              {report.crisis.probability12m && (
                <span className="num text-[12px] text-slate-600 dark:text-slate-300">
                  概率区间 {report.crisis.probability12m.low}%–{report.crisis.probability12m.high}%
                </span>
              )}
            </div>

            {report.waterfall && (
              <div className="mt-3">
                <p className="eyebrow mb-1 text-[10px] text-slate-400 dark:text-slate-500">归因拆解</p>
                <WaterfallChart items={report.waterfall} />
                <p className="num mt-1 text-[10px] text-slate-400">
                  各项贡献之和 = 合计（校验用）：
                  {report.waterfall
                    .filter((w) => w.kind === 'item')
                    .reduce((s, w) => s + w.value, 0)
                    .toFixed(1)}{' '}
                  vs 总分 {report.crisis.score}
                </p>
              </div>
            )}

            <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
              {report.crisis.factors.map((f) => (
                <FactorRow key={f.key} f={f} />
              ))}
            </ul>
            {report.crisis.probability12m && (
              <p className="mt-2 text-[10.5px] leading-relaxed text-slate-400 dark:text-slate-500">
                {report.crisis.probability12m.note}
              </p>
            )}
          </>
        ) : (
          <div className="mt-2 rounded-lg border border-dashed border-[var(--line)] p-3">
            <p className="text-[12.5px] font-medium text-slate-700 dark:text-slate-200">未计算（不是 0 分）</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
              缺：{report?.macro.missing.join('、') || '宏观数据'}。
              新闻只能说明"大家在聊什么"，说明不了"资产多贵、钱多贵"——用新闻算危机概率等于编。
            </p>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-400 dark:text-slate-500">
              接入方式：模块默认从 FRED 免 key 的 CSV 拉 10Y 国债 / 高收益债 OAS / 纳指；
              若服务器网络受限，可在 <code className="num">server/.env</code> 配 <code className="num">FRED_API_KEY</code> 走 API 兜底。
            </p>
            {report?.macro.notes.map((note) => (
              <p key={note} className="mt-1 text-[10.5px] text-slate-400 dark:text-slate-500">
                {note}
              </p>
            ))}
          </div>
        )}
      </section>

      {/* ===== 脆弱实体（CRS ≥ 50 才有意义） ===== */}
      {report && report.vulnerableEntities.length > 0 && (
        <section className="card p-4">
          <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">
            当前宏观背景下最脆弱的 Top {report.vulnerableEntities.length} AI 实体
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            依据：负面新闻占比、热度退潮幅度、缺乏实质融资（"资金流出最快"目前没有资金流数据，用这三个代理指标）。
          </p>
          <div className="mt-2">
            <VulnerableList items={report.vulnerableEntities} />
          </div>
        </section>
      )}

      {/* ===== 历史回溯 ===== */}
      <section className="card p-4">
        <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">历史回溯（近一年）</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          NFI 与 CRS 的日快照；红色虚线标出已知重大事件，可用来检验"分数高点"与"真实事件"是否对得上。
        </p>
        <div className="mt-2">
          <RiskHistoryChart days={365} />
        </div>
      </section>

      {report && (
        <p className="border-t border-[var(--line)] pt-2.5 text-[10.5px] leading-relaxed text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
          {report.disclaimer}
        </p>
      )}
    </div>
  )
}
