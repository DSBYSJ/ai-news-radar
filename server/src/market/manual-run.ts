/**
 * 手工补录收盘价（v0.39.0）
 *
 *   node src/market/manual-run.ts --list
 *   node src/market/manual-run.ts --symbol=SMCI --date=2026-10-20 --price=45.2 --note="官网收盘价"
 *   node src/market/manual-run.ts --delete --symbol=SMCI --date=2026-10-20
 *
 * 用途：FMP 免费档没覆盖的标的（实测 18 家里有 12 家取不到），
 * 允许手工补一个价格点，让它也能算出 P/S。
 *
 * ⚠️ 补录值优先级高于接口值，页面上会标「补录」徽标。
 *    补录是**临时手段**，不能替代正式数据源 —— 补录点太少时分位没有意义
 *    （分位要求 ≥60 个样本点）。
 */
import { getDb } from '../db.ts'
import { listManualPrices, saveManualPrice } from './prices.ts'

const argv = process.argv.slice(2)
const val = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const db = getDb()

if (argv.includes('--list')) {
  const rows = listManualPrices(db, val('symbol'))
  if (rows.length === 0) {
    console.log('\n暂无补录记录\n')
  } else {
    console.log('\n补录记录（symbol / date / close / note）')
    console.log('-'.repeat(72))
    for (const r of rows) {
      console.log(
        `${r.symbol.padEnd(6)} ${r.date}  ${r.close.toFixed(2).padStart(9)}  ${r.note ?? ''}`.trimEnd(),
      )
    }
    console.log(`\n共 ${rows.length} 条\n`)
  }
  db.close()
  process.exit(0)
}

if (argv.includes('--delete')) {
  const symbol = val('symbol')?.toUpperCase()
  const date = val('date')
  if (!symbol || !date) {
    console.error('删除需要 --symbol= 与 --date=')
    process.exit(1)
  }
  const r = db.prepare('DELETE FROM manual_price WHERE symbol = ? AND date = ?').run(symbol, date)
  console.log(r.changes > 0 ? `已删除 ${symbol} ${date}` : `未找到 ${symbol} ${date}`)
  db.close()
  process.exit(0)
}

const symbol = val('symbol')
const date = val('date')
const price = Number(val('price'))

if (!symbol || !date || !Number.isFinite(price)) {
  console.error('用法：--symbol=SMCI --date=2026-10-20 --price=45.2 [--note="来源"]')
  console.error('　　　--list [--symbol=SMCI]　/　--delete --symbol= --date=')
  process.exit(1)
}

try {
  saveManualPrice(db, { symbol, date, close: price, note: val('note') })
  console.log(`已补录 ${symbol.toUpperCase()} ${date} = ${price}`)
  const all = listManualPrices(db, symbol)
  console.log(`${symbol.toUpperCase()} 现有补录 ${all.length} 条（分位需 ≥60 个样本点才有意义）`)
} catch (err) {
  console.error(`补录失败：${String(err)}`)
  process.exit(1)
}
db.close()
