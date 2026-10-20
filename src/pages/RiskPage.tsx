import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { RiskFactor, RiskReport } from '../types.ts'

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

function FactorRow({ f }: { f: RiskFactor }) {
  const score = f.score
  return (
    <li className="py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-slate-700 dark:text-slate-200">{f.label}</span>
        <span className="num text-[11px] text-slate-400 dark:text-slate-500">
          {score === null ? '未参与' : `${score}`} × {f.weight}%
        </span>
        <span className="num ml-auto text-[11px] text-slate-400 dark:text-slate-500">
          {f.value === null ? '—' : f.value}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.07]">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${score ?? 0}%`, backgroundColor: barColor(score) }}
        />
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-slate-400 dark:text-slate-500">{f.note}</p>
    </li>
  )
}

/**
 * AI 估值与金融危机风险（独立模块）
 *
 * 页面刻意把「能算的」和「算不了的」分开摆在最显眼处：
 * 叙事指数（NFI）随时可算；危机风险分缺宏观数据时**显示为未计算**并列出缺什么。
 * 不把"新闻热度"包装成"估值"或"崩盘概率"。
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

  const n = report?.narrative
  const band = BAND_TEXT[n?.band ?? 'unknown']

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
            叙事泡沫指数用站内新闻算；危机风险分必须接利率/信用利差/指数，缺数据就不出概率。
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

      {/* 叙事泡沫指数 */}
      {n && (
        <section className="card card-accent p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">叙事泡沫指数 NFI</p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="num text-[34px] font-semibold leading-none" style={{ color: barColor(n.nfi) }}>
                  {n.nfi ?? '—'}
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
              <p>窗口 {n.windowDays} 天</p>
              <p className="mt-0.5">{n.articles} 条入库</p>
              <p className="mt-0.5">情感判定 {n.classified} 条</p>
            </div>
          </div>

          <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 dark:divide-white/[0.06] dark:border-white/[0.06]">
            {n.factors.map((f) => (
              <FactorRow key={f.key} f={f} />
            ))}
          </ul>
        </section>
      )}

      {/* 危机风险分 */}
      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">危机风险分 CRS</p>
          <p className="text-[10.5px] text-slate-400 dark:text-slate-500">未来 12 个月</p>
        </div>

        {/* 三个宏观读数：先看事实，再看合成分 */}
        {report && Object.keys(report.macro.series).length > 0 && (
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {Object.values(report.macro.series).map((s) => (
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
          </div>
        )}

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

      {/* 怎么读这个分 */}
      <details className="rounded-xl border border-[var(--line)] px-3 py-2">
        <summary className="cursor-pointer list-none text-[11px] text-slate-500 dark:text-slate-400">
          怎么读这个分？
        </summary>
        <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          <p>
            <b className="text-slate-600 dark:text-slate-300">四个分项各管一件事：</b>
            利率 = 折现率（长久期资产最怕它涨）、信用 = 借钱贵不贵（借钱便宜=自满）、
            指数 = 已经涨了多少（超涨=脆弱）、叙事 = 讨论热不热（过热是泡沫的必要条件）。
          </p>
          <p>
            <b className="text-slate-600 dark:text-slate-300">分档：</b>
            0–30 低（常态）· 30–50 需留意 · 50–70 偏高 · 70+ 高。四项里有两三项同时偏高位，才值得紧张。
          </p>
          <p>
            <b className="text-slate-600 dark:text-slate-300">概率区间：</b>
            以 12%/年 的危机基础率为锚、按风险分做指数调整，±5pp 是区间宽度。
            参数是人为设定的、没做历史回测 —— 所以看量级就行，别当精确值。
          </p>
          <p>
            <b className="text-slate-600 dark:text-slate-300">最该记住的一点：</b>
            分数高不等于明天崩，分数低也不等于安全。它衡量的是「脆弱性」，
            真正引爆还需要一个触发事件（政策、财报、某家公司暴雷）。
          </p>
        </div>
      </details>

      {/* 观察项 + 免责 */}
      {n && (
        <section className="card p-4">
          <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">不计分的观察项</p>
          <ul className="mt-1.5 space-y-1">
            {n.observations.map((o) => (
              <li key={o.key} className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                <span className="font-medium text-slate-600 dark:text-slate-300">{o.label}：</span>
                {o.value}
              </li>
            ))}
          </ul>
          {report && (
            <p className="mt-3 border-t border-slate-100 pt-2.5 text-[10.5px] leading-relaxed text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
              {report.disclaimer}
            </p>
          )}
        </section>
      )}
    </div>
  )
}
