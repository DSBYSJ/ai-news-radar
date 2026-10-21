/**
 * 实体映射审计（v0.44.0）
 *
 *   node src/market/entity-audit-run.ts            # 审计报告
 *   node src/market/entity-audit-run.ts --unknown  # 只看仍待处理的实体
 *
 * 输出四个指标（不是只报一个"映射率"）：
 *   1. Unknown 处理率   —— 多少实体已经分类，多少还缺证据
 *   2. 可映射事件覆盖率 —— 直接 / 间接分开
 *   3. 映射准确性       —— 列出每条映射的证据与置信度，供人工抽查
 *   4. 新增有效样本数   —— 补别名后真正多出多少个可结算事件
 *
 * 第 4 项要区分三层：分类完成 ≠ 股票可映射 ≠ 事件结果可评估。
 */
import { getDb } from '../db.ts'
import { ENTITY_CLASS_LABELS, classifyEntity, type EntityClass } from './entityClass.ts'
import { ENTITY_REGISTRY, REGISTRY_VERSION, type Confidence } from './entityRegistry.ts'
import { MAPPING_VERSION, replayCoverage } from './linkageObs.ts'
import { symbolOfEntity } from './universe.ts'

const argv = process.argv.slice(2)
const onlyUnknown = argv.includes('--unknown')
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
const db = getDb()

/** 中文占两列，padEnd 会错位 —— 自己算显示宽度 */
const width = (s: string): number => [...s].reduce((n, ch) => n + (/[\u2E80-\uFFEF]/.test(ch) ? 2 : 1), 0)
const padW = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - width(s)))

/* ---------- 1. 仍待处理的实体（按事件数） ---------- */
if (onlyUnknown) {
  // 用**当前规则**重放一遍，而不是读冻结的旧分类 —— 否则补完别名也看不到变化
  const r = replayCoverage(db, { asOf: today })
  const stored = db
    .prepare(
      `SELECT entity_raw AS entity, COUNT(*) AS events, SUM(mentions) AS mentions
         FROM linkage_observations GROUP BY entity_raw`,
    )
    .all() as unknown as { entity: string; events: number; mentions: number }[]
  const rows = stored
    .map((u) => ({ ...u, m: classifyEntity(u.entity, symbolOfEntity, { eventDate: today }) }))
    .filter((u) => u.m.entityClass === 'unknown')
    .sort((a, b) => b.events - a.events)

  console.log(`\n仍缺证据的实体（${rows.length} 个，映射规则 ${MAPPING_VERSION}）`)
  console.log('实体                        事件  提及')
  console.log('-'.repeat(48))
  for (const u of rows) console.log(`${u.entity.padEnd(26)} ${String(u.events).padStart(3)}  ${String(u.mentions).padStart(4)}`)
  console.log(`\n共 ${r.entities.total} 个实体，已分类 ${r.entities.total - rows.length} 个`)
  console.log('（在 entityRegistry.ts 里登记后重放自动生效；历史记录不会被改写）\n')
  db.close()
  process.exit(0)
}

/* ---------- 2. 重放对比 ---------- */
const replay = replayCoverage(db, { asOf: today })
const pct = (n: number): string => (replay.totalEvents > 0 ? `${((n / replay.totalEvents) * 100).toFixed(1)}%` : '—')
const classes: EntityClass[] = ['listed', 'product', 'private', 'noncorporate', 'unknown']

console.log(`\n=== 实体映射审计 ===  规则 ${MAPPING_VERSION}（registry ${REGISTRY_VERSION}）`)
console.log(`事件总数 ${replay.totalEvents}　截止 ${today}`)

console.log('\n--- 指标1：分类分布（补别名前 → 后）---')
console.log(`${padW('类别', 30)} 补前        补后        变化`)
console.log('-'.repeat(72))
for (const c of classes) {
  const b = replay.before[c] ?? 0
  const a = replay.after[c] ?? 0
  const d = a - b
  console.log(
    `${padW(ENTITY_CLASS_LABELS[c], 30)} ${String(b).padStart(4)}(${pct(b).padStart(5)})  ${String(a).padStart(4)}(${pct(a).padStart(5)})  ${d === 0 ? '—' : (d > 0 ? `+${d}` : String(d))}`,
  )
}

const mappedBefore = (replay.before.listed ?? 0) + (replay.before.product ?? 0)
const mappedAfter = (replay.after.listed ?? 0) + (replay.after.product ?? 0)
console.log('\n--- 指标2：可映射事件覆盖率 ---')
console.log(`  直接映射（listed）   ${replay.before.listed} → ${replay.after.listed}`)
console.log(`  间接映射（product）  ${replay.before.product} → ${replay.after.product}`)
console.log(`  合计覆盖             ${mappedBefore}(${pct(mappedBefore)}) → ${mappedAfter}(${pct(mappedAfter)})`)
console.log(
  `  企业类未映射         ${(replay.before.private ?? 0) + (replay.before.unknown ?? 0)} → ${(replay.after.private ?? 0) + (replay.after.unknown ?? 0)}`,
)
console.log(`  非企业实体（本无股票） ${replay.before.noncorporate} → ${replay.after.noncorporate}`)

console.log('\n--- 指标4：新增有效样本 ---')
console.log(`  新映射的事件      ${replay.newlyMapped}`)
console.log(`  其中可结算 T0 的  ${replay.newlyEvaluable}　（其余映射到了但没有行情数据）`)
const stillUnknown = replay.entities.stillUnknown
const handled = replay.entities.total - stillUnknown.length
console.log(
  `  实体维度：共 ${replay.entities.total} 个，已分类 ${handled} 个（${((handled / replay.entities.total) * 100).toFixed(0)}%），仍缺证据 ${stillUnknown.length} 个`,
)
if (stillUnknown.length > 0) {
  console.log(`  仍缺证据：${stillUnknown.slice(0, 12).join('、')}${stillUnknown.length > 12 ? ' …' : ''}`)
}

if (replay.rows.length > 0) {
  console.log('\n--- 变化明细（按事件数）---')
  console.log('实体                        事件  补前 → 补后')
  console.log('-'.repeat(66))
  for (const r of replay.rows.slice(0, 20)) {
    const before = `${ENTITY_CLASS_LABELS[r.beforeClass]}${r.beforeSymbol ? ` ${r.beforeSymbol}` : ''}`
    const after = `${ENTITY_CLASS_LABELS[r.afterClass]}${r.afterSymbol ? ` ${r.afterSymbol}` : ''}`
    const extra = r.newEvaluable > 0 ? `　+${r.newEvaluable} 可结算` : ''
    console.log(`${r.entity.padEnd(26)} ${String(r.events).padStart(3)}  ${before} → ${after}${extra}`)
  }
}

/* ---------- 3. 映射准确性：证据清单（供人工抽查） ---------- */
console.log(`\n--- 指标3：映射证据清单（${ENTITY_REGISTRY.length} 条，可人工抽查）---`)
const byConf: Record<Confidence, number> = { confirmed: 0, likely: 0, unverified: 0 }
for (const e of ENTITY_REGISTRY) byConf[e.confidence] += 1
console.log(`  confirmed ${byConf.confirmed}　likely ${byConf.likely}　unverified ${byConf.unverified}`)
for (const e of ENTITY_REGISTRY) {
  const target = e.symbol ? `${e.symbol}${e.parentName ? `（${e.parentName}）` : ''}` : e.parentName ? `未上市（${e.parentName}）` : '—'
  console.log(`  [${e.confidence.padEnd(10)}] ${e.name.padEnd(24)} → ${target}`)
  console.log(`               证据：${e.evidence.slice(0, 76)}`)
}

console.log('\n提示：改 entityRegistry.ts 后需重跑本命令查看效果；已落库的历史记录不会被改写。\n')
db.close()
