import type { DatabaseSync } from 'node:sqlite'

/** Preserve the unit, period and filing behind every input, rather than only the latest scalar. */
export interface FinancialFact {
  metric: 'revenue' | 'netIncome' | 'shares'
  tag: string; unit: 'USD' | 'shares'; start: string | null; end: string
  filed: string; accession: string; form: string; value: number; url: string
}
interface RawFact { start?: string; end: string; filed: string; accn?: string; form?: string; val: number }
export interface FactsDocument { cik?: number | string; facts?: Record<string, Record<string, { units: Record<string, RawFact[]> }>> }
const DAY = 86_400_000
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b)-Date.parse(a))/DAY)
export function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s
}
const TAGS: Record<FinancialFact['metric'], string[]> = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax','RevenueFromContractWithCustomerIncludingAssessedTax','Revenues','SalesRevenueNet','Revenue','RevenueFromContractsWithCustomers'],
  netIncome: ['NetIncomeLossAvailableToCommonStockholdersBasic','NetIncomeLoss','ProfitLossAttributableToOwnersOfParent'],
  shares: ['EntityCommonStockSharesOutstanding','CommonStockSharesOutstanding'],
}

export function parseFinancialFacts(json: FactsDocument, cik = String(json.cik ?? '')): FinancialFact[] {
  if (!/^\d+$/.test(cik)) return []
  const facts = new Map<string, FinancialFact>(), conflicts = new Set<string>()
  for (const metric of ['revenue','netIncome','shares'] as const) {
    const unit = metric === 'shares' ? 'shares' : 'USD'
    for (const ns of ['dei','us-gaap','ifrs-full']) for (const tag of TAGS[metric]) {
      for (const f of json.facts?.[ns]?.[tag]?.units[unit] ?? []) {
        if (!f.accn || !/^\d{10}-\d{2}-\d{6}$/.test(f.accn) || !/^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(f.form ?? '') ||
          !validDate(f.end) || !validDate(f.filed) || f.end > f.filed || !Number.isFinite(f.val)) continue
        if (metric === 'shares' ? Boolean(f.start) || f.val <= 0 : !f.start || !validDate(f.start) || daysBetween(f.start,f.end)<60 || daysBetween(f.start,f.end)>380) continue
        const key = `${metric}|${ns}:${tag}|${f.start??''}|${f.end}|${f.accn}`
        if (conflicts.has(key)) continue
        if (facts.has(key) && facts.get(key)!.value !== f.val) { facts.delete(key); conflicts.add(key); continue }
        facts.set(key,{metric,tag:`${ns}:${tag}`,unit,start:f.start??null,end:f.end,filed:f.filed,accession:f.accn,form:f.form!,value:f.val,
          url:`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accn.replaceAll('-','')}/${f.accn}-index.html`})
      }
    }
  }
  return [...facts.values()].sort((a,b)=>a.end.localeCompare(b.end)||a.filed.localeCompare(b.filed))
}

export function loadFinancialFacts(db: DatabaseSync, symbol: string): FinancialFact[] {
  const row = db.prepare('SELECT payload FROM market_financial_facts WHERE symbol = ?').get(symbol) as {payload:string}|undefined
  if (!row) return []
  try { return JSON.parse(row.payload) as FinancialFact[] } catch { return [] }
}

export interface FinancialBasis {
  kind: 'ttm' | 'annual'; periodStart: string; periodEnd: string; filedAt: string
  revenue: number; netIncome: number | null; shares: FinancialFact | null
  components: { operation: 'annual' | 'add' | 'subtract'; revenue: FinancialFact; netIncome: FinancialFact | null }[]
  reasons: string[]
}
const tagOrder = (f: FinancialFact) => TAGS[f.metric].indexOf(f.tag.split(':')[1])
function latestVersions(rows: FinancialFact[]): FinancialFact[] {
  const groups = new Map<string,FinancialFact>()
  for(const f of rows) {
    const key=`${f.tag}|${f.start??''}|${f.end}`, old=groups.get(key)
    if(!old || f.filed>old.filed || f.filed===old.filed&&f.accession>old.accession)groups.set(key,f)
  }
  return [...groups.values()]
}

/** FY + current YTD - comparable prior YTD. No annualising a quarter, no mixing currencies/tags. */
export function financialBasisAt(facts: FinancialFact[], date: string, maxAnnualAge = 550): FinancialBasis | null {
  // Companyfacts has no acceptance time: use filings only from the following calendar day.
  const known=facts.filter(f=>f.filed<date && f.end<date), revenue=latestVersions(known.filter(f=>f.metric==='revenue'))
  const annuals=revenue.filter(f=>f.start&&daysBetween(f.start,f.end)>=350).sort((a,b)=>b.end.localeCompare(a.end)||tagOrder(a)-tagOrder(b)||b.filed.localeCompare(a.filed))
  const annual=annuals[0]
  if(!annual || annual.value<=0 || daysBetween(annual.end,date)>maxAnnualAge)return null
  const newer=revenue.filter(f=>f.end>annual.end && f.start && daysBetween(annual.end,f.start)===1 && daysBetween(f.start,f.end)<=300)
    .sort((a,b)=>b.end.localeCompare(a.end)||tagOrder(a)-tagOrder(b)||b.filed.localeCompare(a.filed))
  let selected: {operation:'annual'|'add'|'subtract';revenue:FinancialFact}[]=[{operation:'annual',revenue:annual}]
  const reasons:string[]=[]
  if(newer.length) {
    const current=newer[0]
    const matchingAnnual=annuals.find(f=>f.end===annual.end&&f.tag===current.tag)
    const prior=revenue.filter(f=>f.tag===current.tag&&f.start===matchingAnnual?.start&&
      Math.abs(daysBetween(f.start!,f.end)-daysBetween(current.start!,current.end))<=7&&daysBetween(f.end,current.end)>=350&&daysBetween(f.end,current.end)<=380)
      .sort((a,b)=>Number(b.accession===current.accession)-Number(a.accession===current.accession)||b.filed.localeCompare(a.filed))[0]
    if(matchingAnnual&&prior) selected=[{operation:'annual',revenue:matchingAnnual},{operation:'add',revenue:current},{operation:'subtract',revenue:prior}]
    else reasons.push('最新累计期间无法配齐同标签的上年全年与上年同期；保留年报口径')
  }
  const income=(r:FinancialFact)=>known.filter(f=>f.metric==='netIncome'&&f.start===r.start&&f.end===r.end&&f.accession===r.accession)
    .sort((a,b)=>tagOrder(a)-tagOrder(b))[0]??null
  const components=selected.map(c=>({...c,netIncome:income(c.revenue)}))
  if(components.length===1)reasons.push('当前仅使用完整年度申报；不是按单季乘四推算的 TTM')
  const revenueValue=components.reduce((s,c)=>s+(c.operation==='subtract'?-1:1)*c.revenue.value,0)
  if(!Number.isFinite(revenueValue)||revenueValue<=0)return null
  const incomeComplete=components.every(c=>c.netIncome!==null)&&new Set(components.map(c=>c.netIncome?.tag)).size===1
  const netIncome=incomeComplete?components.reduce((s,c)=>s+(c.operation==='subtract'?-1:1)*c.netIncome!.value,0):null
  if(!incomeComplete)reasons.push('净利润未能与每段营收配到同一申报及同一标签，P/E 留空')
  const shareRows=latestVersions(known.filter(f=>f.metric==='shares'&&daysBetween(f.end,date)<=400))
    .sort((a,b)=>b.end.localeCompare(a.end)||tagOrder(a)-tagOrder(b)||b.filed.localeCompare(a.filed))
  let shares:FinancialFact|null=shareRows[0]??null
  if(shares&&shareRows.some(f=>f.end===shares!.end&&f.filed===shares!.filed&&Math.abs(f.value/shares!.value-1)>0.05)) {
    shares=null; reasons.push('同一观测日与申报日的总股本存在冲突，暂停估值')
  }
  if(!shares)reasons.push('缺少 400 天内可溯源的总股本；不以加权平均股数冒充期末股本')
  const current=components.find(c=>c.operation==='add')?.revenue??annual
  return {kind:components.length===3?'ttm':'annual',periodStart:components.length===3?new Date(Date.parse(components[2].revenue.end)+DAY).toISOString().slice(0,10):annual.start!,
    periodEnd:current.end,filedAt:components.map(c=>c.revenue.filed).sort().at(-1)!,revenue:revenueValue,netIncome,shares,components,reasons}
}
