/**
 * 新闻→股价联动：每日观察任务（v0.43.0）
 *
 *   node src/market/linkage-run.ts                    # 记录 + 结算 + 快照（今天）
 *   node src/market/linkage-run.ts --as-of=2026-10-20 # 按指定截止日复现
 *   node src/market/linkage-run.ts --dry              # 只看不写
 *
 * 幂等：重复运行不会重复插入事件，也不会覆盖首次记录的事实。
 * 定时任务可以随便重跑 —— 这是单机采集架构下最基本的要求。
 */
import { getDb } from '../db.ts'
import {
  ALGO_VERSION,
  MAPPING_VERSION,
  computeStats,
  listSnapshots,
  recordObservations,
  settleObservations,
  writeSnapshot,
} from './linkageObs.ts'
import { ENTITY_CLASS_LABELS } from './entityClass.ts'

const argv = process.argv.slice(2)
const argOf = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const dry = argv.includes('--dry')
// 默认"今天"用北京时间日期，与快照口径一致
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
const asOf = argOf('as-of') ?? today

const db = getDb()
const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`)

console.log(`\n联动观察　截止日 ${asOf}　算法 ${ALGO_VERSION}　映射 ${MAPPING_VERSION}${dry ? '　（dry run）' : ''}`)

const rec = recordObservations(db, { asOf })
console.log(`[记录] 扫到 ${rec.scanned} 个跨源事件，新增 ${rec.inserted}，已存在 ${rec.existing}`)

if (!dry) {
  const s = settleObservations(db, { asOf })
  console.log(
    `[结算] 检查 ${s.checked}：成熟 ${s.matured} / 等待数据 ${s.pending} / 缺行情 ${s.noPrice}` +
      (s.revised > 0 ? `　修订 ${s.revised} 条` : ''),
  )
}

const st = computeStats(db, { asOf })
console.log('\n--- 状态分布 ---')
console.log(`  事件总数 ${st.totalEvents}`)
console.log(
  `  已成熟 ${st.byStatus.matured}　等待数据 ${st.byStatus.pending}　缺行情 ${st.byStatus.no_price}　无法映射 ${st.byStatus.unmapped}`,
)

console.log('\n--- 实体分类（映射率分开算）---')
for (const [k, v] of Object.entries(st.byClass)) {
  const share = st.totalEvents > 0 ? ((v / st.totalEvents) * 100).toFixed(1) : '0.0'
  console.log(`  ${ENTITY_CLASS_LABELS[k as keyof typeof ENTITY_CLASS_LABELS].padEnd(18)} ${String(v).padStart(4)}　${share}%`)
}
console.log(
  `  → 直接映射 ${st.mapping.direct}　间接映射 ${st.mapping.indirect}　未映射 ${st.mapping.none}`,
)

console.log('\n--- 结果 ---')
console.log(`  T0  N=${st.t0.evaluated}　均值 ${pct(st.t0.avg)}　中位 ${pct(st.t0.median)}　胜率 ${pct(st.t0.winRate)}`)
console.log(`  T+5 N=${st.t5.evaluated}　均值 ${pct(st.t5.avg)}　中位 ${pct(st.t5.median)}　胜率 ${pct(st.t5.winRate)}`)
if (st.concentration) {
  console.log(`  集中度：${st.concentration.symbol} 占 ${Math.round(st.concentration.share * 100)}% 的已成熟样本`)
}
console.log(`  行情截止 ${st.priceDataUntil ?? '—'}`)
console.log(`\n${st.sufficient ? '✓' : '⚠️'} ${st.note}`)

if (!dry) {
  const snap = writeSnapshot(db, { asOf })
  console.log(`\n[快照] 已写入 linkage_daily_snapshots（${snap.date}，新增事件 ${snap.newEvents}）`)
  const hist = listSnapshots(db, 5)
  if (hist.length > 1) {
    console.log('最近快照：')
    for (const h of hist) {
      console.log(`  ${h.date}　事件 ${h.totalEvents}　成熟 ${h.byStatus.matured}　T+5 N=${h.t5.evaluated}　均值 ${pct(h.t5.avg)}`)
    }
  }
}

console.log('')
db.close()
