import type { MacroSnapshot, MacroPoint } from './macro.ts'
import type { CrsFactor } from './calculation.ts'

export const PRESSURE_MODEL = 'market-pressure-v3'
const DAY = 86_400_000
export interface PressureFeature extends CrsFactor {
  unit: string; referenceFrom: string; referenceUntil: string; observations: number
  previousValue: number | null; change: number | null; changeUnit: string; scoreChange: number | null; sourceUrl: string
}
export interface MarketPressure {
  model: typeof PRESSURE_MODEL; score: number | null; asOf: string | null
  status: 'ready' | 'unavailable'; factors: PressureFeature[]; reasons: string[]
  formula: string; note: string
  comparison: {date:string;score:number;change:number} | null
}
type Point = { date: string; value: number }
const round = (v: number, digits = 2) => Number(v.toFixed(digits))

/** 验证日期/单位，按实际观测日期截断；拒绝冲突日期和“最新值”错配。 */
function pointsOf(point: MacroPoint | undefined, today: string, positive: boolean): Point[] | null {
  if (!point || point.history.length !== point.dates.length || point.asOf > today || !Number.isFinite(point.value)) return null
  const byDate = new Map<string, number>()
  for (let i = 0; i < point.dates.length; i++) {
    const date = point.dates[i], value = point.history[i]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) return null
    if (date > point.asOf) continue
    if (byDate.has(date) && byDate.get(date) !== value) return null
    byDate.set(date, value)
  }
  const points = [...byDate].map(([date,value]) => ({date,value})).sort((a,b) => a.date.localeCompare(b.date))
  const last = points.at(-1)
  return last?.date === point.asOf && last.value === point.value ? points : null
}

function features(credit: Point[], equity: Point[]) {
  const level = credit.map(p => ({...p}))
  const widening: Point[] = [], drawdown: Point[] = [], volatility: Point[] = []
  for (let i = 20; i < credit.length; i++) {
    if (Date.parse(credit[i].date)-Date.parse(credit[i-20].date) > 45*DAY) continue
    widening.push({date:credit[i].date,value:credit[i].value-credit[i-20].value})
  }
  for (let i = 20; i < equity.length; i++) {
    const period = equity.slice(i-20,i+1)
    if (Date.parse(period.at(-1)!.date)-Date.parse(period[0].date) <= 45*DAY) {
      const returns = period.slice(1).map((p,j) => Math.log(p.value/period[j].value))
      const mean = returns.reduce((a,b)=>a+b,0)/returns.length
      const variance = returns.reduce((a,b)=>a+(b-mean)**2,0)/(returns.length-1)
      volatility.push({date:equity[i].date,value:Math.sqrt(variance*252)*100})
    }
    if (i < 251 || Date.parse(equity[i].date)-Date.parse(equity[i-251].date)>400*DAY) continue
    const peak = Math.max(...equity.slice(i-251,i+1).map(p=>p.value))
    drawdown.push({date:equity[i].date,value:(1-equity[i].value/peak)*100})
  }
  return [
    {key:'credit_level',label:'信用利差水平',unit:'%',points:level},
    {key:'credit_change',label:'20 日利差变化',unit:'pp',points:widening},
    {key:'equity_drawdown',label:'252 日高点回撤',unit:'%',points:drawdown},
    {key:'equity_volatility',label:'20 日实现波动率',unit:'% 年化',points:volatility},
  ]
}

/** 描述性压力读数。信用/股市两组各半，组内等权；不拟合危机概率。 */
export function marketPressure(macro: MacroSnapshot, opts: { now?: number } = {}): MarketPressure {
  const now = opts.now ?? Date.now(), today = new Date(now).toISOString().slice(0,10)
  const formula = '信用组 50%（利差水平、20 日走阔各半）+ 股市组 50%（252 日回撤、20 日实现波动率各半）；每项以此前三年观测的中位秩标准化。'
  const note = '0–100 是四项历史分位的平均值，不是合成分自身的百分位或危机概率。50 仅表示平均历史位置；低利差、股市上涨、新闻热度和倒挂不加当前压力分。'
  const unavailable = (reasons: string[], asOf: string | null = null, factors: PressureFeature[] = []): MarketPressure =>
    ({model:PRESSURE_MODEL,score:null,status:'unavailable',asOf,factors,reasons,formula,note,comparison:null})
  const credit = pointsOf(macro.series.creditSpread,today,false), equity = pointsOf(macro.series.nasdaq,today,true)
  if (!credit || !equity) return unavailable(['信用或指数序列缺失、日期冲突、超前或最新值与历史不一致，暂停计算'])
  const equityDates = new Set(equity.map(p=>p.date))
  const asOf = credit.filter(p=>equityDates.has(p.date)).at(-1)?.date ?? null
  if (!asOf || now-Date.parse(asOf)>7*DAY) return unavailable(['没有七天内的共同观测日期；暂停计算'],asOf)
  const cutoff = new Date(Date.parse(asOf)-3*365.25*DAY).toISOString().slice(0,10)
  const commonDates=credit.filter(p=>p.date<=asOf&&equityDates.has(p.date)).map(p=>p.date)
  const previousDate=commonDates.at(-21)??null
  const factors: PressureFeature[] = [], reasons: string[] = []
  for (const feature of features(credit.filter(p=>p.date<=asOf),equity.filter(p=>p.date<=asOf))) {
    const current = feature.points.at(-1)
    const history = feature.points.filter(p=>p.date>=cutoff && p.date<asOf)
    if (current?.date!==asOf || history.length<252) {
      reasons.push(`${feature.label}有效历史 ${history.length}/252 个观测，或共同日期缺少有效值`)
      continue
    }
    // 不含当前观测；并列取中位秩，常数序列给 50，避免伪极端。
    const value = current.value
    const percentile = (history.filter(p=>p.value<value).length+history.filter(p=>p.value===value).length/2)/history.length
    const score = percentile*100
    const previous=feature.points.find(p=>p.date===previousDate)?.value??null
    // Freeze today's reference distribution so a changing baseline cannot masquerade as a market move.
    const oldRank=previous===null?null:(history.filter(p=>p.value<previous).length+history.filter(p=>p.value===previous).length/2)/history.length*100
    factors.push({key:feature.key,label:feature.label,value:round(value),unit:feature.unit,
      previousValue:previous===null?null:round(previous),change:previous===null?null:round(value-previous),scoreChange:oldRank===null?null:round(score-oldRank,1),
      changeUnit:feature.key==='equity_volatility'?'pp 年化':'pp',
      sourceUrl:`https://fred.stlouisfed.org/series/${feature.key.startsWith('credit_')?'BAMLH0A0HYM2':'NASDAQCOM'}`,
      percentile:round(percentile,4),z:null,score:round(score,1),weight:25,contribution:round(score/4,2),
      referenceFrom:history[0].date,referenceUntil:history.at(-1)!.date,observations:history.length,
      note:`${history[0].date} 至 ${history.at(-1)!.date}，${history.length} 个既往观测；当前不入基准，非独立事件样本。`})
  }
  if (reasons.length) return unavailable(reasons,asOf,factors)
  const score=round(factors.reduce((sum,f)=>sum+f.contribution,0),1)
  const change=factors.every(f=>f.scoreChange!==null)?round(factors.reduce((sum,f)=>sum+f.scoreChange!/4,0),1):null
  return {model:PRESSURE_MODEL,score,status:'ready',asOf,factors,reasons,formula,note,
    comparison:change!==null&&previousDate?{date:previousDate,score:round(score-change,1),change}:null}
}
