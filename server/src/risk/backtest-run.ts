/**
 * 风险模型历史回测 CLI
 *
 *   node src/risk/backtest-run.ts                 # 默认：训练 2013–2019 / 测试 2020 起
 *   node src/risk/backtest-run.ts --json          # 输出完整 JSON（便于存档对比）
 *   node src/risk/backtest-run.ts --threshold=55  # 手动指定告警阈值
 *
 * ⚠️ 前提：`macro_history` 里要有**真实观测日期**的宏观序列。
 * 早期版本的回填按「末尾日期倒推一天」伪造日期，跑出来的结论不可信 ——
 * 先跑一次 `npm run risk:backfill -- --days=180 --apply` 让日期被真实值覆盖。
 */
import { getDb } from '../db.ts'
import { runBacktest, EVENT_LABELS, type EventKey } from './backtest.ts'

const db = getDb()
const json = process.argv.includes('--json')
const thresholdArg = process.argv.find((a) => a.startsWith('--threshold='))
const threshold = thresholdArg ? Number(thresholdArg.slice(12)) : undefined

const report = runBacktest(db, { threshold })

if (json) {
  console.log(JSON.stringify(report, null, 2))
  db.close()
  process.exit(0)
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
const fmt = (x: number | null): string => (x === null ? '—' : String(x))

console.log('\n=== 风险模型历史回测 ===')
console.log(`数据区间 ${report.dataRange.from} ~ ${report.dataRange.to}　${report.sampling}`)
console.log(`训练段 ${report.trainWindow.from} ~ ${report.trainWindow.to}　测试段 ${report.testWindow.from} ~ ${report.testWindow.to}`)
console.log(`告警阈值 CRS ≥ ${report.events.drawdown20.test.atThreshold.threshold}\n`)

console.log('序列覆盖：')
for (const c of report.seriesCoverage) {
  console.log(`  ${c.series.padEnd(13)} ${String(c.rows).padStart(5)} 行　${c.from} ~ ${c.to}`)
}

for (const key of Object.keys(EVENT_LABELS) as EventKey[]) {
  const { train, test } = report.events[key]
  console.log(`\n【${EVENT_LABELS[key]}】`)
  console.log(`  样本 ${test.samples}（正 ${test.positives}，基础发生率 ${pct(test.baseRate)}）　有效独立样本≈${test.effectiveSamples}`)
  console.log(`  AUC　训练 ${train.auc.toFixed(3)}　测试 ${test.auc.toFixed(3)}　(0.5 = 随机)`)
  const bl = test.baselines.map((b) => `${b.name} ${b.auc.toFixed(3)}`).join('　')
  console.log(`  单指标基线（测试段）：${bl}`)
  const a = test.atThreshold
  console.log(
    `  阈值告警：命中率 ${pct(a.hitRate)}　误报率 ${pct(a.falseAlarmRate)}　精确率 ${pct(a.precision)}　` +
      `年均告警 ${a.alertsPerYear} 次　中位提前 ${fmt(test.medianLeadDays)} 天`,
  )
}

console.log('\n已知局限：')
for (const c of report.caveats) console.log(`  · ${c}`)
console.log('\n（用 --json 可输出完整结果存档）\n')
db.close()
