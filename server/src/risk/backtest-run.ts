/**
 * 风险模型历史回测 CLI
 *
 *   node src/risk/backtest-run.ts                 # 主实验 + 辅助实验
 *   node src/risk/backtest-run.ts --json          # 完整 JSON（存档对比）
 *
 * 报告口径（v0.29.0 按外部评审意见重写）：
 *   - 主实验：训练 2006–2014（含 2008）/ 测试 2015 起
 *   - 辅助实验：训练 2013–2019 / 测试 2020 起
 *   - 两个切分都打印，**不挑好看的那个**
 *
 * ⚠️ 前提：`macro_history` 必须是真实观测日期（先跑 risk:backfill --apply）。
 */
import { getDb } from '../db.ts'
import { runBacktest, EVENT_LABELS, type EventKey, type SplitResult } from './backtest.ts'

const db = getDb()
const json = process.argv.includes('--json')
const report = runBacktest(db)

if (json) {
  console.log(JSON.stringify(report, null, 2))
  db.close()
  process.exit(0)
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
const f3 = (x: number): string => x.toFixed(3)

console.log('\n=== 风险模型历史回测 ===')
console.log(report.positioning)
console.log(`\n数据区间 ${report.dataRange.from} ~ ${report.dataRange.to}`)
console.log(report.sampling)

console.log('\n--- 泄漏检查 ---')
for (const c of report.leakChecks) {
  console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}　${c.detail}`)
}

function printSplit(s: SplitResult): void {
  console.log(`\n=== ${s.name} ===`)
  console.log(
    `训练 ${s.trainFrom} ~ ${s.trainTo}（purging 后实际截止 ${s.purgeCutoff}，${s.trainSamples} 样本）` +
      `　→ 测试 ${s.testFrom} ~ ${s.testTo}（${s.testSamples} 样本）`,
  )
  console.log(`阈值 CRS ≥ ${s.threshold.value}　规则：${s.threshold.rule}`)

  for (const key of Object.keys(EVENT_LABELS) as EventKey[]) {
    const m = s.events[key]
    const bs = s.bootstrap[key].map((b) => `${b.blockLength}月[${b.lo ?? '—'}, ${b.hi ?? '—'}]`).join(' ')
    console.log(`\n  【${m.label}】`)
    console.log(
      `    样本 ${m.samples}（正 ${m.positives}，基础率 ${pct(m.baseRate)}）　有效独立样本≈${m.effectiveSamples}`,
    )
    console.log(
      `    AUC ${f3(m.auc)}（反向 ${f3(m.aucInverted)}，方向判定：${m.direction === 'correct' ? '正常' : m.direction === 'inverted' ? '⚠️ 可能反了' : '无区分'}）`,
    )
    console.log(`    区块 bootstrap：${bs}`)
    console.log(
      `    独立事件召回 ${pct(m.eventRecall)}（${m.eventsHit}/${m.eventsTotal}）　每年误报 ${m.alertsPerYear} 次` +
        `　中位提前 ${m.medianLeadDays === null ? '—' : `${m.medianLeadDays} 天`}`,
    )
    console.log(`    FPR ${pct(m.fpr)}（非事件月份误报）　FDR ${pct(m.fdr)}（告警中无事件的比例）`)
    for (const d of m.eventDetail) {
      console.log(
        `      · ${d.label}（${d.date}）${d.hit ? `✅ 提前 ${d.leadDays} 天` : '❌ 未预警'}` +
          `　窗口最高分 ${d.maxScoreInWindow ?? '—'}`,
      )
    }
  }

  console.log('\n  逐因子消融（目标：纳指回撤，测试段）')
  console.log('    变体                 测试AUC   Δ     事件召回  每年误报')
  for (const a of s.ablation) {
    console.log(
      `    ${a.name.padEnd(20)} ${f3(a.testAuc)}  ${(a.deltaAuc >= 0 ? '+' : '') + f3(a.deltaAuc)}  ` +
        `${pct(a.eventRecall).padStart(6)}  ${String(a.alertsPerYear).padStart(8)}`,
    )
  }
}

printSplit(report.splits.main)
printSplit(report.splits.aux)

console.log('\n--- 已知局限 ---')
for (const c of report.caveats) console.log(`  · ${c}`)
console.log('\n（用 --json 输出完整结果存档）\n')
db.close()
