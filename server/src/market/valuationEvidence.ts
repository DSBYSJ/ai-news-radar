import { financialBasisAt, daysBetween, type FinancialBasis, type FinancialFact } from './financialFacts.ts'
import { splitFactor } from './splits.ts'
import type { StockSplit } from './fmp.ts'
import type { PriceRow } from './prices.ts'
import type { ValuationPoint } from './valuation.ts'

export interface EvidenceValuationPoint extends ValuationPoint { financial: FinancialBasis }

/** Only real last available quotes; distant/mid-month observations never impersonate month-end. */
export function buildEvidenceValuation(prices: PriceRow[], facts: FinancialFact[], splits: StockSplit[], adjustmentAsOf: string): EvidenceValuationPoint[] {
  const monthly=new Map<string,PriceRow>()
  for(const p of [...prices].sort((a,b)=>a.date.localeCompare(b.date))) if(p.date<=adjustmentAsOf)monthly.set(p.date.slice(0,7),p)
  const out:EvidenceValuationPoint[]=[]
  for(const p of monthly.values()) {
    const f=financialBasisAt(facts,p.date)
    if(!f||!f.shares||!Number.isFinite(p.close)||p.close<=0)continue
    // A split between observation and filing makes the instant fact's unit basis ambiguous.
    // Do not guess whether the issuer retrospectively restated it.
    const ambiguous=splits.some(s=>s.date>f.shares!.end&&s.date<=f.shares!.filed)
    const factor=splitFactor(splits,f.shares.filed,adjustmentAsOf),marketCap=p.close*f.shares.value*factor
    const financialAgeDays=daysBetween(f.periodEnd,p.date)
    const reliable=!ambiguous&&daysBetween(f.shares.end,p.date)<=400&&financialAgeDays<=(f.kind==='ttm'?200:550)
    if(ambiguous)f.reasons.push('股本观测至申报期间发生拆股，无法确认该事实是否重列，暂停估值')
    if(financialAgeDays>(f.kind==='ttm'?200:550))f.reasons.push('财务期间超过时效门槛，暂停估值')
    out.push({date:p.date,close:p.close,marketCap,ps:marketCap/f.revenue,pe:f.netIncome!==null&&f.netIncome>0?marketCap/f.netIncome:null,
      manual:p.manual===true,financial:f,basis:{fiscalEnd:f.periodEnd,filedAt:f.filedAt,pitReliable:true,splitFactor:factor,
        sharesAsOf:f.shares.end,sharesFiledAt:f.shares.filed,shareBasisReliable:reliable,financialAgeDays}})
  }
  return out
}

/** Exact period comparable history, separate P/S and P/E. No arbitrary composite score. */
export function evidenceReference(series:EvidenceValuationPoint[],current:EvidenceValuationPoint,verified:boolean) {
  const cutoff=new Date(Date.parse(current.date)-3*365.25*86_400_000).toISOString().slice(0,10)
  const valid=verified?series.filter(p=>p.date>=cutoff&&p.date.slice(0,7)<current.date.slice(0,7)&&!p.manual&&p.basis?.shareBasisReliable&&
    p.financial.kind===current.financial.kind&&daysBetween(p.date,new Date(Date.UTC(Number(p.date.slice(0,4)),Number(p.date.slice(5,7)),0)).toISOString().slice(0,10))<=4):[]
  const summarize=(metric:'ps'|'pe')=>{
    const values=valid.filter(p=>p[metric]!==null&&Number.isFinite(p[metric])&&p[metric]!>0)
    const xs=values.map(p=>p[metric]!).sort((a,b)=>a-b),n=xs.length,v=current[metric]
    const percentile=n>=24&&v!==null?(xs.filter(x=>x<v).length+xs.filter(x=>x===v).length/2)/n:null
    const quantile=(q:number)=>n?xs[Math.floor((n-1)*q)]!:null
    return {percentile,months:n,median:n?n%2?xs[(n-1)/2]:(xs[n/2-1]+xs[n/2])/2:null,
      low:quantile(.25),high:quantile(.75),from:values[0]?.date??null,until:values.at(-1)?.date??null}
  }
  return {ps:summarize('ps'),pe:summarize('pe')}
}
