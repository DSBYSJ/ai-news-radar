import { useState } from 'react'
import type { RiskBacktest, RiskQuality, SubIndex } from '../../types.ts'
import { colorOf, HEALTHY } from './riskColors.ts'

/**
 * 风险可信度 / 子指数 / 回测结论（v0.28.0）
 *
 * 设计立场：把「测出来的风险高」和「数据够不够算」分开显示。
 * 风险分 58 可能是真的偏高，也可能是 20 条样本算出来的噪声 ——
 * 两者在旧界面上长得一模一样，这是最容易被误读的地方。
 */

const LEVEL_STYLE: Record<RiskQuality['level'], { color: string; text: string }> = {
  high: { color: HEALTHY, text: '数据充足' },
  medium: { color: '#f5a623', text: '基本可用' },
  low: { color: '#e5484d', text: '样本偏薄' },
}

export function QualityBar({ quality }: { quality: RiskQuality }) {
  const [open, setOpen] = useState(false)
  const style = LEVEL_STYLE[quality.level]
  const q = quality.news

  return (
    <section className="risk-panel rounded-2xl p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] tracking-[0.12em] text-slate-400">数据可信度</span>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ color: style.color, background: `${style.color}1f` }}
          >
            {style.text}
          </span>
        </div>
        <span className="num text-[11px] text-slate-500">
          {quality.score} / 100
          {quality.macro.staleDays !== null && ` · 宏观滞后 ${quality.macro.staleDays} 天`}
        </span>
      </div>

      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${quality.score}%`, background: style.color }} />
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span>
          新闻 <b className="num text-slate-300">{q.articles}</b> 条
        </span>
        <span>
          独立源 <b className="num text-slate-300">{q.independentSources}</b>
        </span>
        <span>
          情感覆盖 <b className="num text-slate-300">{(q.sentimentCoverage * 100).toFixed(0)}%</b>
        </span>
        <span>
          实体覆盖 <b className="num text-slate-300">{(q.entityCoverage * 100).toFixed(0)}%</b>
        </span>
      </div>

      {(quality.unavailable.length > 0 || quality.notes.length > 0) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-2 text-[10px] text-slate-500 underline decoration-dotted hover:text-slate-300"
        >
          {open ? '收起' : `哪些项没算 / 有哪些限制（${quality.unavailable.length + quality.notes.length}）`}
        </button>
      )}

      {open && (
        <div className="mt-1.5 space-y-1">
          {quality.unavailable.map((u) => (
            <p key={u} className="text-[10px] leading-relaxed text-amber-500/90">
              · 未参与计算：{u}
            </p>
          ))}
          {quality.notes.map((n) => (
            <p key={n} className="text-[10px] leading-relaxed text-slate-500">
              · {n}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}

export function SubIndexRow({ subIndices }: { subIndices: { overheat: SubIndex; stress: SubIndex; fragility: SubIndex } }) {
  const items = [subIndices.overheat, subIndices.stress, subIndices.fragility]
  return (
    <section className="risk-panel rounded-2xl p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] tracking-[0.12em] text-slate-400">风险类型拆解</p>
        <p className="text-[10px] text-slate-500">总分相同，处境可能完全不同（不参与总分）</p>
      </div>
      <div className="mt-2 grid gap-2.5 sm:grid-cols-3">
        {items.map((s) => (
          <div key={s.label} className="rounded-xl bg-white/[0.03] p-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-slate-300">{s.label}</span>
              <span className="num text-[13px] font-semibold" style={{ color: colorOf(s.score) }}>
                {s.score}
              </span>
            </div>
            <p className="mt-0.5 text-[9.5px] text-slate-500">{s.question}</p>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full" style={{ width: `${s.score}%`, background: colorOf(s.score) }} />
            </div>
            <div className="mt-1.5 space-y-0.5">
              {s.parts.map((p) => (
                <div key={p.label} className="flex items-baseline justify-between text-[9.5px] text-slate-500">
                  <span className="truncate">{p.label}</span>
                  <span className="num ml-1 shrink-0">
                    {p.score}
                    <span className="text-slate-600"> ×{p.weight}%</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[9.5px] leading-relaxed text-slate-500">{subIndices.overheat.note}</p>
    </section>
  )
}

/** 回测结论：模型到底有没有区分能力 */
export function BacktestCard({ data }: { data: RiskBacktest }) {
  const [open, setOpen] = useState(false)
  const rows = Object.entries(data.events)
  const anyUseful = rows.some(([, v]) => v.test.auc >= 0.6 && v.test.positives >= 10)
  const noPower = rows.every(([, v]) => v.test.positives < 10)

  return (
    <section className="risk-panel rounded-2xl p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] tracking-[0.12em] text-slate-400">历史回测 · 这个分数准不准</p>
        <span className="num text-[10px] text-slate-500">
          {data.dataRange.from} ~ {data.dataRange.to} · {data.sampling}
        </span>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-slate-500">
              <th className="py-1 pr-2 text-left font-normal">预测目标</th>
              <th className="py-1 px-2 text-right font-normal">正样本</th>
              <th className="py-1 px-2 text-right font-normal">训练 AUC</th>
              <th className="py-1 px-2 text-right font-normal">测试 AUC</th>
              <th className="py-1 px-2 text-right font-normal">误报率</th>
              <th className="py-1 pl-2 text-right font-normal">中位提前</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, v]) => {
              const good = v.test.auc >= 0.6 && v.test.positives >= 10
              return (
                <tr key={key} className="border-t border-white/[0.06]">
                  <td className="py-1.5 pr-2 text-slate-300">{v.test.label}</td>
                  <td className="num py-1.5 px-2 text-right text-slate-400">{v.test.positives}</td>
                  <td className="num py-1.5 px-2 text-right text-slate-400">{v.train.auc.toFixed(2)}</td>
                  <td
                    className="num py-1.5 px-2 text-right font-semibold"
                    style={{ color: good ? HEALTHY : v.test.auc < 0.5 ? '#e5484d' : '#f5a623' }}
                  >
                    {v.test.auc.toFixed(2)}
                  </td>
                  <td className="num py-1.5 px-2 text-right text-slate-400">
                    {(v.test.atThreshold.falseAlarmRate * 100).toFixed(0)}%
                  </td>
                  <td className="num py-1.5 pl-2 text-right text-slate-400">
                    {v.test.medianLeadDays === null ? '—' : `${v.test.medianLeadDays} 天`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p
        className="mt-2 rounded-lg px-2.5 py-1.5 text-[10px] leading-relaxed"
        style={{
          color: anyUseful ? HEALTHY : '#f5a623',
          background: anyUseful ? `${HEALTHY}14` : '#f5a62314',
        }}
      >
        {noPower
          ? '⚠️ 正样本太少（<10），统计上没有检验力 —— 目前无法判断这个分数准不准，只能当作"方向提示"。'
          : anyUseful
            ? '测试段 AUC ≥ 0.6 且样本充足：有初步区分能力，但仍需更多独立事件验证。'
            : '⚠️ 测试段 AUC 未达 0.6：目前没有证据表明这个分数能提前识别风险。请勿把它当概率使用。'}
      </p>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-1.5 text-[10px] text-slate-500 underline decoration-dotted hover:text-slate-300"
      >
        {open ? '收起' : `已知局限（${data.caveats.length}）`}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {data.caveats.map((c) => (
            <p key={c} className="text-[9.5px] leading-relaxed text-slate-500">
              · {c}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
