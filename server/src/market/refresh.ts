import type { DatabaseSync } from 'node:sqlite'
import { syncFundamentals } from './fundamentals.ts'
import { syncPrices, syncRatios } from './prices.ts'
import { syncSplits } from './splits.ts'
import { UNIVERSE } from './universe.ts'

/** 一个入口更新财报、拆股与行情，防止页面只刷新了股价却继续用旧财报。 */
export async function syncMarketData(db: DatabaseSync, opts: { only?: string[] } = {}) {
  const wanted = UNIVERSE.filter(c => !opts.only?.length || opts.only.includes(c.symbol)).map(c => c.symbol)
  const needs = wanted.filter(symbol => {
    const row = db.prepare('SELECT MAX(updated_at) AS updated, MAX(shares_filed_at) AS checked FROM company_fundamentals WHERE symbol = ?').get(symbol) as {updated:string|null;checked:string|null}
    return !row.checked || !row.updated || Date.now()-Date.parse(row.updated)>86_400_000
  })
  const fundamentals = needs.length ? await syncFundamentals(db,{only:needs}).catch(() => ({companies:needs.length,rows:0,skipped:needs.map(symbol=>({symbol,reason:'SEC 更新失败，保留已有财报'})),ms:0}))
    : {companies:0,rows:0,skipped:[],ms:0}
  const splits = await syncSplits(db,{only:wanted})
  // 复权基准变化时必须回拉历史，不能只覆盖近五天形成两套价格单位。
  const prices = await syncPrices(db,{...opts,full:splits.changed.length>0})
  const ratios = await syncRatios(db,opts)
  return {fundamentals,splits,prices,ratios}
}
