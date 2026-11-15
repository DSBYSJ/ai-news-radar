import type { DatabaseSync } from 'node:sqlite'
import { deriveAll, deriveMetrics, summarizeSegments, loadFundamentals, type SegmentSummary } from './fundamentals.ts'
import { SEGMENT_LABELS, UNIVERSE } from './universe.ts'
import { type ValuationBasis } from './valuation.ts'
import { loadFinancialFacts, financialBasisAt, daysBetween, type FinancialBasis } from './financialFacts.ts'
import { buildEvidenceValuation, evidenceReference } from './valuationEvidence.ts'
import { loadPrices } from './prices.ts'
import { loadSplitHistory } from './splits.ts'

export const VALUATION_MODEL = 'filing-evidence-v3'
export interface MarketCompanyRow {
  symbol: string; name: string; segment: string; segmentLabel: string; role: string
  fiscalEnd: string | null; filedAt: string | null; revenue: number | null; netIncome: number | null
  revenueGrowth: number | null; netMargin: number | null; roe: number | null; stale: boolean
  close: number | null; marketCap: number | null; ps: number | null; pe: number | null
  psPercentile: number | null; pePercentile: number | null; points: number; manualPrice: boolean
  missingValuation: string | null; psHistory: { fiscalEnd: string; ps: number }[]
  priceDate: string | null; priceAgeDays: number | null; financialAgeDays: number | null
  splitCheckedAt: string | null; basis: ValuationBasis | null
  valuationState: 'ready' | 'limited' | 'blocked' | 'unavailable'
  relativeScore: number | null; interpretation: string; reasons: string[]; metricsUsed: string[]
  historyMonths: number; peMonths: number; historyFrom: string | null; historyUntil: string | null
  historicalPsMedian: number | null; historicalPeMedian: number | null
  peerPercentile: number | null; peerCount: number
  financial: FinancialBasis | null
  psRange: [number,number] | null; peRange: [number,number] | null
  peHistoryFrom: string | null; peHistoryUntil: string | null
}
export interface MarketOverview {
  generatedAt: string; model: string; methodology: string[]
  coverage: { total: number; priced: number; valued: number; referenced: number; blocked: number; lossMaking: number
    note: string; windowFrom: string | null; windowTo: string | null; windowYears: number | null }
  freshness: { priceUntil: string | null; newestPriceDate: string | null; lastSyncAt: string | null; daysBehind: number | null; status: 'ok' | 'lag' | 'stale' | 'unknown' }
  segments: (SegmentSummary & { psMedian: number | null; percentileMedian: number | null; valuationCovered: number })[]
  companies: MarketCompanyRow[]
}
function median(values: number[]) {
  const clean = values.filter(Number.isFinite).sort((a,b) => a-b), i = Math.floor(clean.length/2)
  return clean.length ? clean.length % 2 ? clean[i] : (clean[i-1]+clean[i])/2 : null
}

export function buildMarketOverview(db: DatabaseSync, opts: { now?: number } = {}): MarketOverview {
  const now = opts.now ?? Date.now(), today = new Date(now).toISOString().slice(0,10)
  const fundamentals = deriveAll(db, today)
  const rows: MarketCompanyRow[] = UNIVERSE.map(company => {
    const prices = loadPrices(db,company.symbol).filter(p => p.date <= today && Number.isFinite(p.close) && p.close > 0)
    const price = prices.at(-1) ?? null
    const annualFacts = loadFundamentals(db,company.symbol)
    const facts = loadFinancialFacts(db,company.symbol)
    // 公司详情与倍数严格使用报价日期当时可见的同一财报版本。
    const f = deriveMetrics(company,annualFacts,price?.date ?? today)
    const financial = financialBasisAt(facts,price?.date??today)
    const actions = loadSplitHistory(db,company.symbol)
    const splitVerified = Boolean(price && actions.checkedAt && actions.checkedAt.slice(0,10) >= price.date && actions.checkedAt <= new Date(now).toISOString())
    const series = buildEvidenceValuation(prices,facts,actions.splits,price?.date??today)
    const latest = series.at(-1)?.date === price?.date ? series.at(-1)! : null
    const priceAgeDays = price ? Math.max(0,Math.floor((now-Date.parse(price.date))/86_400_000)) : null
    const financialAgeDays = financial ? Math.max(0,Math.floor((now-Date.parse(financial.periodEnd))/86_400_000)) : null
    const reasons: string[] = [...(latest?.financial.reasons??financial?.reasons??[])]
    if (!facts.length) reasons.push('缺少带申报编号的 SEC 原始事实，请同步财报；旧年度缓存不冒充已溯源数据')
    if (!price) reasons.push('暂无行情，不能计算倍数')
    if (price?.manual) reasons.push('当前为手工补录报价，不参与自动估值或历史排名')
    if (priceAgeDays !== null && priceAgeDays > 7) reasons.push(`行情滞后 ${priceAgeDays} 天`)
    if (!latest) reasons.push('缺少可配对的已披露股本或年报')
    if (financialAgeDays !== null && financialAgeDays > (financial?.kind==='ttm'?200:550)) reasons.push('财务期间过旧，暂停估值')
    if (latest && !latest.basis?.pitReliable) reasons.push('缺少真实申报日')
    if (latest && !latest.basis?.shareBasisReliable) reasons.push('股本时效或拆股期间的单位基准未通过核验')
    if (price && !splitVerified) reasons.push('拆股资料未核验到行情日期')
    const valid = Boolean(price && !price.manual && latest && splitVerified && latest.basis?.pitReliable && latest.basis.shareBasisReliable &&
      priceAgeDays !== null && priceAgeDays <= 7 && financialAgeDays !== null && financialAgeDays <= (financial?.kind==='ttm'?200:550))
    const reference = latest ? evidenceReference(series,latest,valid) : null
    const ps = valid ? latest!.ps : null, pe = valid ? latest!.pe : null
    if (valid && ps === null) reasons.push('营收不可用或非正数，P/S 不计算')
    if (valid && pe === null) reasons.push(financial?.netIncome !== null && (financial?.netIncome ?? 1) <= 0 ? '期间亏损或零利润，P/E 不适用' : '缺少同口径净利润，P/E 不计算')
    const psRank = ps === null ? null : reference?.ps.percentile ?? null
    const peRank = pe === null ? null : reference?.pe.percentile ?? null
    const relativeScore = null // Deprecated: different valuation denominators are no longer blended.
    if (valid && psRank === null) reasons.push(`同口径有效月末 ${reference?.ps.months ?? 0}/24，P/S 历史参照不足`)
    if (valid && pe!==null && peRank===null) reasons.push(`正利润有效月末 ${reference?.pe.months ?? 0}/24，P/E 历史参照不足`)
    const valuationState: MarketCompanyRow['valuationState'] = !price ? 'unavailable' : !valid || ps === null ? 'blocked' : psRank===null||peRank===null ? 'limited' : 'ready'
    const interpretation = !valid?'资料待核验':psRank===null&&peRank===null?'可读倍数 · 参照不足':'P/S 与 P/E 独立参照'
    const priorEnd=financial?new Date(Date.parse(financial.periodEnd)-350*86_400_000).toISOString().slice(0,10):''
    const prior=financial?financialBasisAt(facts.filter(x=>x.end<=priorEnd),price?.date??today,1000):null
    const revenueGrowth=financial&&prior&&financial.kind===prior.kind&&daysBetween(prior.periodEnd,financial.periodEnd)<=380?
      (financial.revenue/prior.revenue-1)*100:null
    return { symbol:company.symbol,name:company.name,segment:company.segment,segmentLabel:SEGMENT_LABELS[company.segment],role:company.role,
      fiscalEnd:financial?.periodEnd??null,filedAt:financial?.filedAt??null,revenue:financial?.revenue??null,netIncome:financial?.netIncome??null,
      revenueGrowth,netMargin:financial&&financial.netIncome!==null?financial.netIncome/financial.revenue*100:null,roe:null,stale:f?.stale??false,
      close:price?.close??null,marketCap:valid?latest!.marketCap:null,ps,pe,psPercentile:psRank,pePercentile:peRank,
      points:series.length,manualPrice:price?.manual===true,missingValuation:!valid?reasons.join('；'):null,
      // 趋势改用经过相同核验的月末历史；旧的外部年度倍数不混进新口径。
      psHistory:[],priceDate:price?.date??null,priceAgeDays,financialAgeDays,splitCheckedAt:actions.checkedAt,basis:latest?.basis??null,
      valuationState,relativeScore,interpretation,reasons,metricsUsed:[...(psRank!==null?['P/S']:[]),...(peRank!==null?['P/E']:[])],
      historyMonths:reference?.ps.months??0,peMonths:reference?.pe.months??0,historyFrom:reference?.ps.from??null,historyUntil:reference?.ps.until??null,
      historicalPsMedian:reference?.ps.median??null,historicalPeMedian:reference?.pe.median??null,peerPercentile:null,peerCount:0,financial,
      psRange:reference?.ps.low!=null&&reference.ps.high!=null?[reference.ps.low,reference.ps.high]:null,
      peRange:reference?.pe.low!=null&&reference.pe.high!=null?[reference.pe.low,reference.pe.high]:null,
      peHistoryFrom:reference?.pe.from??null,peHistoryUntil:reference?.pe.until??null }
  })
  for (const row of rows) {
    const peers = rows.filter(r => r.symbol !== row.symbol && r.segment === row.segment && r.ps !== null && r.financial?.kind===row.financial?.kind &&
      r.priceDate&&row.priceDate&&Math.abs(daysBetween(r.priceDate,row.priceDate))<=3)
    row.peerCount = peers.length
    if (row.ps !== null && peers.length >= 3) row.peerPercentile =
      (peers.filter(p => p.ps! < row.ps!).length + peers.filter(p => p.ps === row.ps).length/2)/peers.length
  }
  const segments = summarizeSegments(fundamentals,SEGMENT_LABELS).map(s => {
    const members = rows.filter(r=>r.segment===s.segment&&r.ps!==null)
    return {...s,psMedian:median(members.map(r=>r.ps!)),percentileMedian:null,valuationCovered:members.length}
  })
  const dates = rows.map(r=>r.priceDate).filter((v):v is string=>v!==null).sort()
  const priceUntil = dates[0]??null, newestPriceDate = dates.at(-1)??null
  const daysBehind = priceUntil ? Math.max(0,Math.floor((now-Date.parse(priceUntil))/86_400_000)) : null
  const from = rows.map(r=>r.historyFrom).filter((v):v is string=>v!==null).sort()[0]??null
  const until = rows.map(r=>r.historyUntil).filter((v):v is string=>v!==null).sort().at(-1)??null
  const valued=rows.filter(r=>r.ps!==null).length
  return {generatedAt:new Date(now).toISOString(),model:VALUATION_MODEL,
    methodology:['优先 TTM：上年全年 + 本年累计 − 上年同期；仅配相同营收标签、美元单位、可比财务期间，净利润逐段配同一申报编号。配不齐则明确退回年报口径。',
      '以实际拆股记录统一价格与股本基准。股本申报、拆股核验、行情和财报时效不达标时停止给出估值结论。',
      '历史参照使用近 3 年已结束月份，距实际月末不超过 4 天的真实报价；至少 24 月，当月排除，并列取中位秩。仅比较同一 TTM/年报口径；P/E 历史排除亏损月份，存在盈利子样本选择。',
      'P/S、P/E 独立展示，不再按 60/40 权重混成估值分。四分位区间是实际样本分布，不是公允价格区间、置信区间或买卖信号。',
      '没有申报接收时刻，保守地从申报次日起使用；原始申报可核对，但历史计算并非完整的当时数据发布版本回测。总股本为已披露估计，无法覆盖其后回购、增发和日内变化。',
      '同层 P/S 参照至少需要另外 3 家可用公司，仅作背景；不同商业模式、利润率和增长阶段仍不可直接等同。'],
    freshness:{priceUntil,newestPriceDate,lastSyncAt:(db.prepare('SELECT MAX(updated_at) AS u FROM company_fundamentals').get() as {u:string|null}).u,daysBehind,
      status:daysBehind===null?'unknown':daysBehind<=2?'ok':daysBehind<=7?'lag':'stale'},
    coverage:{total:rows.length,priced:dates.length,valued,referenced:rows.filter(r=>r.psPercentile!==null||r.pePercentile!==null).length,
      blocked:rows.filter(r=>r.valuationState==='blocked').length,lossMaking:rows.filter(r=>r.netIncome!==null&&r.netIncome<=0).length,
      note:`${valued}/${rows.length} 家通过当前估值核验；行情、申报、股本和拆股资料分别检查，缺失不补零。`,windowFrom:from,windowTo:until,
      windowYears:from&&until?Number(((Date.parse(until)-Date.parse(from))/(365.25*86_400_000)).toFixed(1)):null},segments,companies:rows}
}
