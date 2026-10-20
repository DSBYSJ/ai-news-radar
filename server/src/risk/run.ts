/**
 * 独立运行：打印一份风险报告（不依赖前端、不影响任何现有任务）
 *
 *   node src/risk/run.ts --days=30
 */
import { getDb } from '../db.ts'
import { riskReport } from './index.ts'

const days = Math.max(7, Number(process.argv.find((a) => a.startsWith('--days='))?.slice(7) ?? 30))
const report = await riskReport(getDb(), { days })
const n = report.narrative

console.log(`\n叙事泡沫指数（NFI）  ${n.nfi === null ? '—（样本不足）' : n.nfi}  ·  ${n.band}`)
console.log(`窗口 ${n.windowDays} 天 / ${n.articles} 条（已判定情感 ${n.classified} 条）`)
console.log('\n分项：')
for (const f of n.factors) {
  const score = f.score === null ? '—' : String(f.score).padStart(3)
  console.log(`  ${f.label.padEnd(12)} ${score} × ${String(f.weight).padStart(2)}%   ${f.note}`)
}
console.log('\n观察项：')
for (const o of n.observations) console.log(`  ${o.label}：${o.value}`)

if (report.crisis) {
  console.log(`\n危机风险分  ${report.crisis.score}  ·  ${report.crisis.level}`)
  if (report.crisis.probability12m) {
    const p = report.crisis.probability12m
    console.log(`未来 12 个月概率区间：${p.low}%–${p.high}%`)
    console.log(`  ${p.note}`)
  }
} else {
  console.log(`\n危机风险分：未计算（缺 ${report.macro.missing.join('、')}）`)
  for (const note of report.macro.notes) console.log(`  ${note}`)
}
console.log(`\n${report.disclaimer}\n`)
