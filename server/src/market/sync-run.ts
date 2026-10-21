/**
 * 美股 AI 产业链基本面同步 CLI
 *
 *   node src/market/sync-run.ts                  # 全部 18 家
 *   node src/market/sync-run.ts --only=NVDA,AMD  # 只同步指定公司（调试用）
 *
 * 数据来源：SEC EDGAR（免费、无需 key、官方 XBRL）
 * ⚠️ 只同步**基本面**。估值（P/S、P/E）需要行情价格，得先配行情接口的 key。
 */
import { getDb } from '../db.ts'
import { deriveAll, summarizeSegments, syncFundamentals } from './fundamentals.ts'
import { SEGMENT_LABELS } from './universe.ts'
import { secUserAgent } from './sec.ts'

const arg = process.argv.find((a) => a.startsWith('--only='))
const only = arg ? arg.slice(7).split(',').map((s) => s.trim().toUpperCase()) : undefined

const db = getDb()
console.log(`\n同步 ${only ? only.join('/') : '全部'} 的基本面（来源：SEC EDGAR）`)
console.log(`UA: ${secUserAgent()}`)

const r = await syncFundamentals(db, { only })
console.log(`\n完成：${r.companies} 家，写入 ${r.rows} 行，耗时 ${(r.ms / 1000).toFixed(1)}s`)
if (r.skipped.length > 0) {
  console.log('跳过：')
  for (const s of r.skipped) console.log(`  · ${s.symbol}：${s.reason}`)
}

const rows = deriveAll(db)
const fmtB = (v: number | null): string => (v === null ? '—' : `${(v / 1e9).toFixed(1)}B`)
const fmtPct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)

console.log('\n公司              财年        营收      净利      营收增速   净利率    ROE')
console.log('-'.repeat(78))
for (const m of rows) {
  if (!m.latest) {
    console.log(`${m.company.symbol.padEnd(6)} ${m.company.name.padEnd(12)} 无数据`)
    continue
  }
  console.log(
    `${m.company.symbol.padEnd(6)} ${m.company.name.padEnd(12)} ${m.latest.fiscalEnd}${m.stale ? '⚠️' : '  '}  ` +
      `${fmtB(m.latest.revenue).padStart(8)}  ${fmtB(m.latest.netIncome).padStart(8)}  ` +
      `${fmtPct(m.revenueGrowth).padStart(8)}  ${fmtPct(m.netMargin).padStart(7)}  ${fmtPct(m.roe).padStart(7)}`,
  )
}

const staleList = rows.filter((m) => m.stale)
if (staleList.length > 0) {
  console.log(`\n⚠️ 以下公司最新财年已超过 2 年（多半是 XBRL 标签选错，不是真的没更新）：${staleList.map((m) => m.company.symbol).join('、')}`)
}

console.log('\n板块汇总（只统计有数据的公司）')
console.log('板块            覆盖    合计营收    合计净利   净利率(样本)  加权增速')
console.log('-'.repeat(74))
for (const s of summarizeSegments(rows, SEGMENT_LABELS)) {
  console.log(
    `${s.label.padEnd(12)} ${String(s.covered).padStart(2)}/${String(s.companies).padEnd(3)} ` +
      `${fmtB(s.revenue).padStart(9)}  ${fmtB(s.netIncome).padStart(9)}  ` +
      `${(fmtPct(s.netMargin) + `(${s.marginCovered})`).padStart(11)}  ${fmtPct(s.revenueGrowth).padStart(8)}`,
  )
}

console.log('\n⚠️ 这里只有基本面，没有估值倍数 —— P/S、P/E 需要股价，见 docs/AI估值与危机风险模块.md\n')
db.close()
