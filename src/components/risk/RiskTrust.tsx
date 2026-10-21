import { useState } from 'react'
import type { BacktestSplit, QualityStatus, RiskBacktest, RiskQuality, SubIndex } from '../../types.ts'
import { colorOf, HEALTHY } from './riskColors.ts'

/**
 * 风险可信度 / 子指数 / 回测结论（v0.29.0 按外部评审意见重写）
 *
 * 两条呈现原则（评审给的）：
 *   1. **不输出"可信度 86%"这种综合分** —— 权重是拍脑袋定的，却看起来像统计结论。
 *      改成状态标签 + 明确门槛，用户能直接看到哪一环不达标。
 *   2. **回测不挑好看的那个切分** —— 主实验与辅助实验都摆出来，结论不一致就如实说不一致。
 */

const STATUS_STYLE: Record<QualityStatus, { color: string; label: string }> = {
  sufficient: { color: HEALTHY, label: '数据充分' },
  partial: { color: '#f5a623', label: '部分数据' },
  stale: { color: '#f5a623', label: '数据过期' },
  insufficient: { color: '#e5484d', label: '样本不足' },
}

export function QualityBar({ quality }: { quality: RiskQuality }) {
  const [open, setOpen] = useState(false)
  const style = STATUS_STYLE[quality.status]

  return (
    <section className="risk-panel rounded-2xl p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] tracking-[0.12em] text-slate-400">数据质量</span>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ color: style.color, background: `${style.color}1f` }}
          >
            {style.label}
          </span>
        </div>
        {quality.macro.staleDays !== null && (
          <span className="num text-[10px] text-slate-500">宏观数据滞后 {quality.macro.staleDays} 天</span>
        )}
      </div>

      <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-400">{quality.headline}</p>

      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
        {quality.dimensions.map((d) => {
          const s = STATUS_STYLE[d.status]
          return (
            <div key={d.key} className="rounded-lg bg-white/[0.03] px-2 py-1.5">
              <div className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="truncate text-[9.5px] text-slate-500">{d.label}</span>
              </div>
              <p className="num mt-0.5 text-[11px] text-slate-300">{d.value}</p>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-2 text-[10px] text-slate-500 underline decoration-dotted hover:text-slate-300"
      >
        {open ? '收起' : `判定门槛 / 未计算项（${quality.unavailable.length}）`}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1">
          {quality.dimensions.map((d) => (
            <p key={d.key} className="text-[9.5px] leading-relaxed text-slate-500">
              · <b className="text-slate-400">{d.label}</b>：{d.rule}
            </p>
          ))}
          {quality.macro.series
            .filter((s) => s.proxy)
            .map((s) => (
              <p key={s.key} className="text-[9.5px] leading-relaxed text-amber-500/90">
                · {s.proxy}
              </p>
            ))}
          {quality.unavailable.map((u) => (
            <p key={u} className="text-[9.5px] leading-relaxed text-amber-500/90">
              · 未参与计算：{u}
            </p>
          ))}
          {quality.notes.map((n) => (
            <p key={n} className="text-[9.5px] leading-relaxed text-slate-500">
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
        <p className="text-[10px] text-slate-500">诊断用，未经验证、不参与总分与告警</p>
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
    </section>
  )
}

/** 单个切分的表格 */
function SplitTable({ split }: { split: BacktestSplit }) {
  const rows = Object.values(split.events)
  return (
    <div className="mt-2">
      <p className="text-[10px] text-slate-500">
        <b className="text-slate-400">{split.name}</b>　训练 {split.trainFrom}~{split.trainTo}
        （purging 后实际截止 <span className="num">{split.purgeCutoff}</span>，{split.trainSamples} 样本）→ 测试{' '}
        {split.testFrom}~{split.testTo}（{split.testSamples} 样本）　告警阈值 <span className="num">CRS ≥ {split.threshold.value}</span>
      </p>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-slate-500">
              <th className="py-1 pr-2 text-left font-normal">预测目标</th>
              <th className="py-1 px-1.5 text-right font-normal">事件召回</th>
              <th className="py-1 px-1.5 text-right font-normal">每年误报</th>
              <th className="py-1 px-1.5 text-right font-normal">FPR</th>
              <th className="py-1 px-1.5 text-right font-normal">FDR</th>
              <th className="py-1 px-1.5 text-right font-normal">AUC</th>
              <th className="py-1 pl-1.5 text-right font-normal">提前</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const bad = m.direction === 'inverted'
              const ci = split.bootstrap[m.event]?.find((b) => b.blockLength === 12)
              return (
                <tr key={m.event} className="border-t border-white/[0.06]">
                  <td className="py-1.5 pr-2 text-slate-300">
                    {m.label}
                    {bad && <span className="ml-1 text-[9px] text-red-400">方向可疑</span>}
                  </td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-300">
                    {(m.eventRecall * 100).toFixed(0)}%
                    <span className="text-slate-600">
                      ({m.eventsHit}/{m.eventsTotal})
                    </span>
                  </td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-400">{m.alertsPerYear.toFixed(1)}</td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-400">{(m.fpr * 100).toFixed(0)}%</td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-400">{(m.fdr * 100).toFixed(0)}%</td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-300">
                    {m.auc.toFixed(2)}
                    {ci && ci.lo !== null && (
                      <span className="block text-[9px] text-slate-600">
                        [{ci.lo.toFixed(2)}, {ci.hi?.toFixed(2)}]
                      </span>
                    )}
                  </td>
                  <td className="num py-1.5 pl-1.5 text-right text-slate-400">
                    {m.medianLeadDays === null ? '—' : `${m.medianLeadDays}d`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9.5px] text-slate-500">
        {rows[0]?.eventDetail.map((d) => (
          <span key={d.date}>
            {d.hit ? '✅' : '❌'} {d.label}
            {d.hit ? `（提前 ${d.leadDays} 天）` : `（窗口最高 ${d.maxScoreInWindow ?? '—'}）`}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 回测结论：定位 + 泄漏检查 + 两个切分 + 消融 */
export function BacktestCard({ data }: { data: RiskBacktest }) {
  const [open, setOpen] = useState(false)
  const [showAblation, setShowAblation] = useState(false)
  const main = data.splits.main
  const aux = data.splits.aux
  const mainAuc = main.events.drawdown20?.auc ?? 0.5
  const auxAuc = aux.events.drawdown20?.auc ?? 0.5
  // 两个切分结论是否一致（差距 > 0.1 视为不稳定）
  const unstable = Math.abs(mainAuc - auxAuc) > 0.1
  const weak = mainAuc < 0.6 && auxAuc < 0.6

  return (
    <section className="risk-panel rounded-2xl p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] tracking-[0.12em] text-slate-400">历史回测 · 这个分数准不准</p>
        <span className="num text-[10px] text-slate-500">
          {data.dataRange.from} ~ {data.dataRange.to}
        </span>
      </div>

      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{data.positioning}</p>

      {/* 泄漏检查：这是回测可信度的前提 */}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {data.leakChecks.map((c) => (
          <span key={c.name} className="text-[9.5px]" style={{ color: c.ok ? HEALTHY : '#e5484d' }}>
            {c.ok ? '✅' : '❌'} {c.name}
          </span>
        ))}
      </div>

      <SplitTable split={main} />
      <SplitTable split={aux} />

      <p
        className="mt-2.5 rounded-lg px-2.5 py-1.5 text-[10px] leading-relaxed"
        style={{
          color: unstable || weak ? '#f5a623' : HEALTHY,
          background: unstable || weak ? '#f5a62314' : `${HEALTHY}14`,
        }}
      >
        {unstable
          ? `⚠️ 两个切分结论不一致（回撤 AUC ${mainAuc.toFixed(2)} vs ${auxAuc.toFixed(2)}）：说明结果对历史分段敏感，` +
            '不能挑好看的那个当结论。目前只能定位为「可解释的宏观压力描述」，不是已验证的预警模型。'
          : weak
            ? `⚠️ 两个切分都未达 0.6（${mainAuc.toFixed(2)} / ${auxAuc.toFixed(2)}）：当前配置没有显示出足够的预警能力。`
            : `两个切分都 ≥0.6（${mainAuc.toFixed(2)} / ${auxAuc.toFixed(2)}），但仍需更多独立事件验证。`}
      </p>

      <div className="mt-1.5 flex gap-3">
        <button
          type="button"
          onClick={() => setShowAblation(!showAblation)}
          className="text-[10px] text-slate-500 underline decoration-dotted hover:text-slate-300"
        >
          {showAblation ? '收起消融' : '逐因子消融'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-[10px] text-slate-500 underline decoration-dotted hover:text-slate-300"
        >
          {open ? '收起局限' : `已知局限（${data.caveats.length}）`}
        </button>
      </div>

      {showAblation && (
        <div className="mt-1.5 overflow-x-auto">
          <p className="text-[9.5px] text-slate-500">目标：纳指回撤；测试段；Δ = 相对完整模型的 AUC 变化（正 = 去掉后更好）</p>
          <table className="mt-1 w-full text-[9.5px]">
            <thead>
              <tr className="text-slate-500">
                <th className="py-0.5 pr-2 text-left font-normal">变体</th>
                <th className="py-0.5 px-1.5 text-right font-normal">AUC</th>
                <th className="py-0.5 px-1.5 text-right font-normal">Δ</th>
                <th className="py-0.5 px-1.5 text-right font-normal">事件召回</th>
                <th className="py-0.5 pl-1.5 text-right font-normal">每年误报</th>
              </tr>
            </thead>
            <tbody>
              {main.ablation.map((a) => (
                <tr key={a.name} className="border-t border-white/[0.06]">
                  <td className="py-1 pr-2 text-slate-400">{a.name}</td>
                  <td className="num py-1 px-1.5 text-right text-slate-300">{a.testAuc.toFixed(2)}</td>
                  <td
                    className="num py-1 px-1.5 text-right"
                    style={{ color: a.deltaAuc > 0.02 ? '#f5a623' : a.deltaAuc < -0.02 ? '#e5484d' : '#64748b' }}
                  >
                    {(a.deltaAuc >= 0 ? '+' : '') + a.deltaAuc.toFixed(2)}
                  </td>
                  <td className="num py-1 px-1.5 text-right text-slate-400">{(a.eventRecall * 100).toFixed(0)}%</td>
                  <td className="num py-1 pl-1.5 text-right text-slate-400">{a.alertsPerYear.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
