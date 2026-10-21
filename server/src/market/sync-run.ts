/**
 * 美股 AI 产业链数据同步 CLI（v0.37.0）
 *
 *   node src/market/sync-run.ts                    # 基本面 + 行情 + 估值比率
 *   node src/market/sync-run.ts --no-prices        # 只同步基本面（SEC，不消耗 FMP 额度）
 *   node src/market/sync-run.ts --only=NVDA,AMD
 *   node src/market/sync-run.ts --full-prices      # 强制重下 5 年日线（谨慎，吃带宽）
 *
 * 数据来源分工：
 *   SEC EDGAR —— 财报原始事实（免费、无 key、权威）
 *   FMP       —— 股价与历史估值比率（免费档 250 次/天、512MB/月、日线近 5 年）
 */
import { getDb } from '../db.ts'
import { deriveAll, summarizeSegments, syncFundamentals } from './fundamentals.ts'
import { hasFmpKey } from './fmp.ts'
import { syncPrices, syncRatios } from './prices.ts'
import { SEGMENT_LABELS } from './universe.ts'
import { secUserAgent } from './sec.ts'
import { checkAgainstFmpRatios, deriveAllValuations, summarizeSegmentValuation } from './valuation.ts'

const argv = process.argv.slice(2)
const onlyArg = argv.find((a) => a.startsWith('--only='))
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim().toUpperCase()) : undefined
const noPrices = argv.includes('--no-prices')
const fullPrices = argv.includes('--full-prices')

const fmtB = (v: number | null): string => (v === null ? '—' : `${(v / 1e9).toFixed(1)}B`)
const fmtPct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)
const fmtX = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}x`)
const fmtPctile = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`)

const db = getDb()

/* ---------- 1. 基本面（SEC） ---------- */
console.log(`\n[1/3] 基本面（SEC EDGAR）　UA: ${secUserAgent()}`)
const f = await syncFundamentals(db, { only })
console.log(`  写入 ${f.rows} 行，${(f.ms / 1000).toFixed(1)}s`)
for (const s of f.skipped) console.log(`  · 跳过 ${s.symbol}：${s.reason}`)

/* ---------- 2/3. 行情与估值比率（FMP） ---------- */
let priceMsg = ''
if (noPrices) {
  priceMsg = '（--no-prices，跳过行情与估值）'
} else if (!hasFmpKey()) {
  priceMsg = '未配置 FMP_API_KEY，跳过行情与估值'
} else {
  console.log('\n[2/3] 行情（FMP 日线，增量）')
  const p = await syncPrices(db, { only, full: fullPrices })
  console.log(`  写入 ${p.rows} 行，${(p.ms / 1000).toFixed(1)}s`)
  for (const s of p.skipped) console.log(`  · 跳过 ${s.symbol}：${s.reason}`)

  console.log('\n[3/3] 估值比率（FMP 年度）')
  const r = await syncRatios(db, { only })
  console.log(`  写入 ${r.rows} 行，${(r.ms / 1000).toFixed(1)}s`)
  for (const s of r.skipped) console.log(`  · 跳过 ${s.symbol}：${s.reason}`)
}

/* ---------- 基本面表 ---------- */
const rows = deriveAll(db)
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
  console.log(`\n⚠️ 最新财年超过 2 年（多半是 XBRL 标签选错）：${staleList.map((m) => m.company.symbol).join('、')}`)
}

/* ---------- 估值表 ---------- */
if (priceMsg === '') {
  const vals = deriveAllValuations(db)
  console.log('\n估值（trailing：日频价格 × 当时已披露的最近年报）')
  console.log('公司     最新价    市值      P/S     P/S分位   P/E    P/E分位   样本点')
  console.log('-'.repeat(74))
  for (const v of vals) {
    if (!v.latest) {
      console.log(`${v.company.symbol.padEnd(6)} 无估值（缺价格或缺股本）`)
      continue
    }
    console.log(
      `${v.company.symbol.padEnd(6)} ${v.latest.close.toFixed(1).padStart(8)}  ${fmtB(v.latest.marketCap).padStart(8)}  ` +
        `${fmtX(v.latest.ps).padStart(6)}  ${fmtPctile(v.psPercentile).padStart(7)}  ` +
        `${fmtX(v.latest.pe).padStart(6)}  ${fmtPctile(v.pePercentile).padStart(7)}  ${String(v.points).padStart(6)}`,
    )
  }

  const valued = vals.filter((v) => v.latest !== null)
  const priced = vals.filter((v) => v.points > 0)
  console.log(
    `\n覆盖：有价格 ${priced.length}/${vals.length}，可算估值 ${valued.length}/${vals.length}` +
      (valued.length < vals.length
        ? '\n⚠️ FMP 免费档只覆盖部分标的（其余返回 402「不在订阅范围」），不是数据缺失'
        : ''),
  )

  console.log('\n板块估值（等权中位数，避免巨头压死小公司）')
  console.log('板块            覆盖    P/S中位  估值分位中位')
  console.log('-'.repeat(48))
  for (const s of summarizeSegmentValuation(vals, SEGMENT_LABELS)) {
    console.log(
      `${s.label.padEnd(12)} ${String(s.covered).padStart(2)}  ${fmtX(s.psMedian).padStart(8)}  ${fmtPctile(s.percentileMedian).padStart(10)}`,
    )
  }

  /* ---------- 自校验：我们的 P/S vs FMP 的 P/S ---------- */
  console.log('\n自校验（财年末复算 P/S vs FMP 官方 P/S，偏差 >15% 说明口径有问题）')
  let bad = 0
  for (const v of vals.slice(0, 6)) {
    const checks = checkAgainstFmpRatios(db, v.company.symbol)
    const last = checks[checks.length - 1]
    if (!last) continue
    const flag = last.relDiff !== null && last.relDiff > 0.15 ? ' ⚠️' : ''
    if (flag) bad += 1
    console.log(
      `  ${v.company.symbol.padEnd(6)} ${last.fiscalEnd}  我们 ${fmtX(last.ours)}  FMP ${fmtX(last.fmp)}  ` +
        `偏差 ${last.relDiff === null ? '—' : `${(last.relDiff * 100).toFixed(0)}%`}${flag}`,
    )
  }
  if (bad === 0) console.log('  全部在 15% 以内')
} else {
  console.log(`\n${priceMsg}`)
}

/* ---------- 板块基本面 ---------- */
console.log('\n板块基本面汇总')
console.log('板块            覆盖    合计营收    合计净利   净利率(样本)  加权增速')
console.log('-'.repeat(74))
for (const s of summarizeSegments(rows, SEGMENT_LABELS)) {
  console.log(
    `${s.label.padEnd(12)} ${String(s.covered).padStart(2)}/${String(s.companies).padEnd(3)} ` +
      `${fmtB(s.revenue).padStart(9)}  ${fmtB(s.netIncome).padStart(9)}  ` +
      `${(fmtPct(s.netMargin) + `(${s.marginCovered})`).padStart(11)}  ${fmtPct(s.revenueGrowth).padStart(8)}`,
  )
}
console.log('')
db.close()
