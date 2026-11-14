import type { DatabaseSync } from 'node:sqlite'
import { deriveAll, deriveMetrics, summarizeSegments, loadFundamentals, type SegmentSummary } from './fundamentals.ts'
import { SEGMENT_LABELS, UNIVERSE } from './universe.ts'
import { buildDailyValuation, monthlyReference, type ValuationBasis } from './valuation.ts'
import { loadPrices } from './prices.ts'
import { loadSplitHistory } from './splits.ts'

export const VALUATION_MODEL = 'annual-relative-v2'
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
    const facts = loadFundamentals(db,company.symbol)
    // 公司详情与倍数严格使用报价日期当时可见的同一财报版本。
    const f = deriveMetrics(company,facts,price?.date ?? today)
    const actions = loadSplitHistory(db,company.symbol)
    const splitVerified = Boolean(price && actions.checkedAt && actions.checkedAt.slice(0,10) >= price.date && actions.checkedAt <= new Date(now).toISOString())
    const series = buildDailyValuation(prices,facts, {splits:actions.splits,adjustmentAsOf:price?.date})
    const latest = series.at(-1)?.date === price?.date ? series.at(-1)! : null
    const priceAgeDays = price ? Math.max(0,Math.floor((now-Date.parse(price.date))/86_400_000)) : null
    const financialAgeDays = f?.latest ? Math.max(0,Math.floor((now-Date.parse(f.latest.fiscalEnd))/86_400_000)) : null
    const reasons: string[] = []
    if (!price) reasons.push('暂无行情，不能计算倍数')
    if (priceAgeDays !== null && priceAgeDays > 7) reasons.push(`行情滞后 ${priceAgeDays} 天`)
    if (!latest) reasons.push('缺少可配对的已披露股本或年报')
    if (financialAgeDays !== null && financialAgeDays > 550) reasons.push('年报超过 550 天，暂停估值')
    if (latest && !latest.basis?.pitReliable) reasons.push('缺少真实申报日')
    if (latest && !latest.basis?.shareBasisReliable) reasons.push('股本申报口径未核验或与每股利润不一致')
    if (price && !splitVerified) reasons.push('拆股资料未核验到行情日期')
    const valid = Boolean(price && latest && splitVerified && latest.basis?.pitReliable && latest.basis.shareBasisReliable &&
      priceAgeDays !== null && priceAgeDays <= 7 && financialAgeDays !== null && financialAgeDays <= 550)
    const reference = latest ? monthlyReference(series,latest,valid) : null
    const ps = valid ? latest!.ps : null, pe = valid ? latest!.pe : null
    if (valid && ps === null) reasons.push('营收不可用或非正数，P/S 不计算')
    if (valid && pe === null) reasons.push(f?.latest?.netIncome !== null && (f?.latest?.netIncome ?? 1) <= 0 ? '年报亏损，P/E 不适用' : '缺少同口径净利润，P/E 不计算')
    const psRank = ps === null ? null : reference?.psPercentile ?? null
    const peRank = pe === null ? null : reference?.pePercentile ?? null
    const weighted = [{name:'P/S',rank:psRank,weight:60},{name:'P/E',rank:peRank,weight:40}].filter(x => x.rank !== null)
    const relativeScore = weighted.length ? Math.round(weighted.reduce((sum,x) => sum + x.rank! * x.weight,0) / weighted.reduce((sum,x) => sum+x.weight,0) * 100) : null
    if (valid && psRank === null) reasons.push(`可用月末样本 ${reference?.months ?? 0}/24，历史 P/S 参照不足`)
    const valuationState: MarketCompanyRow['valuationState'] = !price ? 'unavailable' : !valid || ps === null ? 'blocked' : relativeScore === null || peRank === null ? 'limited' : 'ready'
    const interpretation = relativeScore === null ? valid && ps !== null ? '可读倍数 · 参照不足' : '资料待核验' : relativeScore >= 80 ? '历史相对高位' : relativeScore <= 20 ? '历史相对低位' : '历史相对中段'
    return { symbol:company.symbol,name:company.name,segment:company.segment,segmentLabel:SEGMENT_LABELS[company.segment],role:company.role,
      fiscalEnd:f?.latest?.fiscalEnd??null,filedAt:f?.latest?.filedAt??null,revenue:f?.latest?.revenue??null,netIncome:f?.latest?.netIncome??null,
      revenueGrowth:f?.revenueGrowth??null,netMargin:f?.netMargin??null,roe:f?.roe??null,stale:f?.stale??false,
      close:price?.close??null,marketCap:valid?latest!.marketCap:null,ps,pe,psPercentile:psRank,pePercentile:peRank,
      points:series.length,manualPrice:price?.manual===true,missingValuation:!valid?reasons.join('；'):null,
      // 趋势改用经过相同核验的月末历史；旧的外部年度倍数不混进新口径。
      psHistory:[],priceDate:price?.date??null,priceAgeDays,financialAgeDays,splitCheckedAt:actions.checkedAt,basis:latest?.basis??null,
      valuationState,relativeScore,interpretation,reasons,metricsUsed:weighted.map(x=>x.name),
      historyMonths:reference?.months??0,peMonths:reference?.peMonths??0,historyFrom:reference?.from??null,historyUntil:reference?.until??null,
      historicalPsMedian:reference?.psMedian??null,historicalPeMedian:reference?.peMedian??null,peerPercentile:null,peerCount:0 }
  })
  for (const row of rows) {
    const peers = rows.filter(r => r.symbol !== row.symbol && r.segment === row.segment && r.ps !== null)
    row.peerCount = peers.length
    if (row.ps !== null && peers.length >= 3) row.peerPercentile =
      (peers.filter(p => p.ps! < row.ps!).length + peers.filter(p => p.ps === row.ps).length/2)/peers.length
  }
  const segments = summarizeSegments(fundamentals,SEGMENT_LABELS).map(s => {
    const members = rows.filter(r=>r.segment===s.segment&&r.ps!==null)
    return {...s,psMedian:median(members.map(r=>r.ps!)),percentileMedian:median(members.map(r=>r.relativeScore).filter((v):v is number=>v!==null).map(v=>v/100)),valuationCovered:members.length}
  })
  const dates = rows.map(r=>r.priceDate).filter((v):v is string=>v!==null).sort()
  const priceUntil = dates[0]??null, newestPriceDate = dates.at(-1)??null
  const daysBehind = priceUntil ? Math.max(0,Math.floor((now-Date.parse(priceUntil))/86_400_000)) : null
  const from = rows.map(r=>r.historyFrom).filter((v):v is string=>v!==null).sort()[0]??null
  const until = rows.map(r=>r.historyUntil).filter((v):v is string=>v!==null).sort().at(-1)??null
  const valued=rows.filter(r=>r.ps!==null).length
  return {generatedAt:new Date(now).toISOString(),model:VALUATION_MODEL,
    methodology:['P/S 与 P/E 均使用同一估算市值分子；财务口径为最近已披露年报，不冒充 TTM 或预测盈利。',
      '以实际拆股记录统一价格与股本基准。股本申报、拆股核验、行情和财报时效不达标时停止给出估值结论。',
      '历史相对位置使用近 3 年已结束月份的月末快照，至少 24 个有效月份；当月不进入基准，并列取中位秩。',
      '双因子相对位置为 P/S 60% + P/E 40%；缺项按可用权重归一并标明。该位置不是公允价值、目标价或买卖信号。',
      '同层 P/S 参照至少需要另外 3 家可用公司，仅作背景；不同商业模式、利润率和增长阶段仍不可直接等同。'],
    freshness:{priceUntil,newestPriceDate,lastSyncAt:(db.prepare('SELECT MAX(updated_at) AS u FROM company_fundamentals').get() as {u:string|null}).u,daysBehind,
      status:daysBehind===null?'unknown':daysBehind<=2?'ok':daysBehind<=7?'lag':'stale'},
    coverage:{total:rows.length,priced:dates.length,valued,referenced:rows.filter(r=>r.relativeScore!==null).length,
      blocked:rows.filter(r=>r.valuationState==='blocked').length,lossMaking:rows.filter(r=>r.netIncome!==null&&r.netIncome<=0).length,
      note:`${valued}/${rows.length} 家通过当前估值核验；行情、申报、股本和拆股资料分别检查，缺失不补零。`,windowFrom:from,windowTo:until,
      windowYears:from&&until?Number(((Date.parse(until)-Date.parse(from))/(365.25*86_400_000)).toFixed(1)):null},segments,companies:rows}
}
