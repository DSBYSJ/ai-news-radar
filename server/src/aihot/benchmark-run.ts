/**
 * AIHOT 外部基准对照 CLI
 *
 *   node src/aihot/benchmark-run.ts              # 24 小时窗口
 *   node src/aihot/benchmark-run.ts --hours=72   # 自定义窗口（>24h 走 7d 模式）
 *   node src/aihot/benchmark-run.ts --json       # 完整 JSON
 *
 * 回答的问题：**同一时间窗里，AIHOT 选了什么、我们选了什么、分歧在哪。**
 * ⚠️ AIHOT 是独立第二标准，不是 ground truth —— 只能看一致性，不能算准确率。
 */
import { getDb } from '../db.ts'
import { runBenchmark } from './benchmark.ts'

const arg = (name: string): number | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(name.length + 3)) : undefined
}

const db = getDb()
const json = process.argv.includes('--json')
const hours = arg('hours') ?? 24
const minScore = arg('minScore') ?? 45

const r = await runBenchmark({ db, hours, minScore })

if (json) {
  console.log(JSON.stringify(r, null, 2))
  db.close()
  process.exit(0)
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

console.log('\n=== AIHOT 外部基准对照 ===')
console.log(`窗口 ${r.window.from.slice(0, 16).replace('T', ' ')} ~ ${r.window.to.slice(0, 16).replace('T', ' ')}（${r.window.hours}h）`)
console.log(`AIHOT 精选 ${r.aihot.count} 条（${r.aihot.sources} 个来源，${r.aihot.requests} 次请求${r.aihot.notModified ? '，命中 304' : ''}）`)
console.log(`本站 ${r.ours.count} 条，其中 ≥${r.ours.minScore} 分 ${r.ours.highScore} 条`)

console.log('\n--- 重合度 ---')
console.log(`  双方都有　${r.overlap.matched} 条`)
console.log(`  只有 AIHOT　${r.overlap.onlyAihot} 条　→ 我们覆盖了它的 ${pct(r.overlap.coverageOfAihot)}`)
console.log(`  只有本站　${r.overlap.onlyOurs} 条　→ 它覆盖了我们的 ${pct(r.overlap.coverageOfOurs)}`)
console.log(`  分类一致率　${r.categoryAgreement === null ? '样本不足' : pct(r.categoryAgreement)}`)
console.log(`  分数秩相关　${r.scoreRankCorrelation ?? '样本不足'}`)

console.log('\n--- AIHOT 的来源构成（用它反推我们缺哪些官方源）---')
for (const [name, n] of Object.entries(r.aihot.bySource)) {
  const x = name.includes('X：') || name.includes('推特')
  console.log(`  ${String(n).padStart(2)}  ${name}${x ? '　（X 账号，按项目规则不抓）' : ''}`)
}

if (r.samples.onlyAihot.length > 0) {
  console.log('\n--- 它选了、我们漏了（前 8）---')
  for (const s of r.samples.onlyAihot) console.log(`  [${s.category}/${s.score}] ${s.title}　—　${s.source}`)
}
if (r.samples.onlyOurs.length > 0) {
  console.log('\n--- 我们选了、它没收（前 8）---')
  for (const s of r.samples.onlyOurs) console.log(`  [${s.category}/${s.score}] ${s.title}　—　${s.source}`)
}
if (r.samples.matched.length > 0) {
  console.log('\n--- 双方都选（前 8，看分数差异）---')
  for (const s of r.samples.matched) {
    console.log(`  它 ${String(s.aihotScore).padStart(3)} / 我们 ${String(s.ourScore).padStart(3)}　${s.title.slice(0, 46)}`)
  }
}

console.log('\n--- 说明 ---')
for (const n of r.notes) console.log(`  · ${n}`)
console.log('\n数据来源：AIHOT（https://aihot.news），匿名只读接口，仅作个人对照使用\n')
db.close()
