import type { DatabaseSync } from 'node:sqlite'
import type { NfiFactor, NfiResult } from './calculation.ts'
import type { NarrativeInputs } from './narrative.ts'
import { publisherOf } from './events.ts'
import { normalizeUrl } from '../collector/fingerprint.ts'
import { stripHtml } from '../collector/parse.ts'
import { symbolOfEntity } from '../market/universe.ts'

export const NARRATIVE_MODEL = 'capital-attention-v3'
const DAY = 86_400_000
const MONEY = /融资|募资|首次公开募股|(?:拟|计划|申请|即将|成功|启动|完成|寻求).{0,5}上市|\b(?:funding|fundrais(?:e|ing)|rais(?:e[sd]?|ing).{0,24}(?:million|billion|funds)|ipo|initial public offering|valuation|valued at)\b/i
const CHASE = /踏空|抢筹|爆买|最后上车|错过就没了|(?:股价|股票|市值).{0,10}(?:暴涨|翻倍|狂飙)|\b(?:fomo|to the moon|must-buy|last chance to buy|all[ -]in (?:on|into))\b/ig
const NEGATED = /(?:警惕|避免|不要|并非|不是|不再|拒绝|否认|澄清|辟谣|反对|切勿|\b(?:avoid|against|not|no|never|deny|denies|warning|warns|without|anti)\b)[^。！？.!?;；]{0,40}$/i
const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu,'').trim()
const round = (value: number, digits = 1) => Number(value.toFixed(digits))
const median = (values: number[]) => {const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2}

/** 仅识别金融追逐措辞；技术性能 10x、产品售罄、普通感叹号不当作投资狂热。 */
export function chaseLanguage(text: string): { hit: boolean; words: string[] } {
  const words = new Set<string>()
  for (const match of text.matchAll(CHASE)) {
    if (NEGATED.test(text.slice(Math.max(0,match.index-65),match.index))) continue
    words.add(match[0].toLowerCase())
  }
  return {hit:words.size>0,words:[...words]}
}

interface ArticleRow {
  id: number; url: string; title: string; summary: string | null; category: string
  sentiment: string | null; entities: string | null; publishedAt: string
}
interface Observation extends ArticleRow { publisher: string; money: boolean; chase: boolean; words: string[] }
export interface EvidenceFactor extends NfiFactor { display: string; unit: string; coverage: string }
export interface NarrativeEvidence extends NfiResult {
  model: typeof NARRATIVE_MODEL; status: 'ready' | 'insufficient'; windowDays: number
  factors: EvidenceFactor[]; partitions: {key:string;label:string;contribution:number;note:string}[]
  sampling: {rawArticles:number;uniqueArticles:number;eligibleArticles:number;publishers:number;eligiblePublishers:number;entityCoverage:number;momentumPublishers:number}
  reasons: string[]; formula: string; note: string; inputs: NarrativeInputs
}

/** 直接测量报道占比，不再把任意五个映射分数加成“泡沫概率”。 */
export function narrativeEvidence(db: DatabaseSync, opts: {days?:number;now?:number} = {}): NarrativeEvidence {
  const now=opts.now??Date.now(),days=Math.max(7,Math.min(180,Math.trunc(opts.days??30)))
  const at=new Date(now).toISOString(),from=new Date(now-Math.max(days,14)*DAY).toISOString()
  // 回放按收录时间截断：后来补采的旧文章不能成为“当时已知”的证据。
  const raw=db.prepare(`SELECT a.id,r.url,r.title,r.summary,a.category,a.sentiment,a.entities,a.published_at AS publishedAt
    FROM articles a JOIN raw_items r ON r.id=a.raw_id
    WHERE a.ai_relevant=1 AND julianday(a.published_at)>=julianday(?) AND julianday(a.published_at)<=julianday(?)
      AND julianday(a.created_at)<=julianday(?) AND julianday(r.fetched_at)<=julianday(?)
    ORDER BY a.published_at,a.id`).all(from,at,at,at) as unknown as ArticleRow[]
  const seenUrls=new Set<string>(),seenTitles=new Set<string>(),all:Observation[]=[]
  for(const row of raw){
    const publisher=publisherOf(row.url),url=normalizeUrl(row.url),title=titleKey(row.title)
    if(!publisher||!title||seenUrls.has(url)||seenTitles.has(`${publisher}|${title}`))continue
    seenUrls.add(url);seenTitles.add(`${publisher}|${title}`)
    const text=stripHtml(`${row.title} ${row.summary??''}`),chase=chaseLanguage(text)
    all.push({...row,publisher,money:MONEY.test(text),chase:chase.hit,words:chase.words})
  }
  const window=all.filter(r=>Date.parse(r.publishedAt)>=now-days*DAY)
  const groups=new Map<string,Observation[]>()
  for(const row of window){const group=groups.get(row.publisher)??[];group.push(row);groups.set(row.publisher,group)}
  const eligible=[...groups.values()].filter(rows=>rows.length>=5),observed=eligible.flat()
  const rate=(predicate:(r:Observation)=>boolean)=>eligible.length?eligible.reduce((sum,rows)=>sum+rows.filter(predicate).length/rows.length,0)/eligible.length:null
  const money=rate(r=>r.money),chase=rate(r=>r.chase),capital=rate(r=>r.money||r.chase)
  const classified=window.filter(r=>['positive','negative','neutral'].includes(r.sentiment??''))
  const positive=classified.filter(r=>r.sentiment==='positive').length,negative=classified.filter(r=>r.sentiment==='negative').length
  // 情感只作背景：每个出版源先算，再等权；来源标注不足的源不借其他源补齐。
  const sentimentSources=eligible.filter(rows=>rows.filter(r=>['positive','negative','neutral'].includes(r.sentiment??'')).length>=5)
  const positiveRate=sentimentSources.length>=3&&sentimentSources.length/Math.max(1,eligible.length)>=.6
    ? sentimentSources.reduce((sum,rows)=>{const known=rows.filter(r=>['positive','negative','neutral'].includes(r.sentiment??''));return sum+known.filter(r=>r.sentiment==='positive').length/known.length},0)/sentimentSources.length : null
  // 每篇文章的实体总权重为一，先源内平均再源间等权；同篇重复和股票别名归一。
  const entities=new Map<string,number>();let entityArticles=0,entitySources=0
  for(const rows of eligible){
    const valid=rows.map(row=>{try{const value:unknown=JSON.parse(row.entities??'null');return Array.isArray(value)?[...new Set(value.filter((v):v is string=>typeof v==='string'&&Boolean(v.trim())).map(v=>symbolOfEntity(v)??v.normalize('NFKC').trim().toLowerCase()))]:[]}catch{return []}}).filter(names=>names.length)
    entityArticles+=valid.length
    if(!valid.length)continue
    entitySources++
    for(const names of valid)for(const name of names)entities.set(name,(entities.get(name)??0)+1/valid.length/names.length)
  }
  const entityCoverage=observed.length?entityArticles/observed.length:0
  const hhi=entityCoverage>=.6&&entitySources>=3?[...entities.values()].reduce((sum,v)=>sum+(v/entitySources)**2,0):null
  // 固定共同来源，取源内同比的中位数；增源不会直接增加可比热度。
  const ratios:number[]=[]
  const weekly=new Map<string,{recent:Observation[];prior:Observation[]}>()
  for(const row of all){
    const time=Date.parse(row.publishedAt)
    if(time<now-14*DAY)continue
    const periods=weekly.get(row.publisher)??{recent:[],prior:[]}
    ;(time>=now-7*DAY?periods.recent:periods.prior).push(row)
    weekly.set(row.publisher,periods)
  }
  for(const {recent,prior} of weekly.values()){
    const active=(rows:Observation[])=>new Set(rows.map(r=>r.publishedAt.slice(0,10))).size
    if(recent.length>=10&&prior.length>=10&&active(recent)>=3&&active(prior)>=3)ratios.push(recent.length/prior.length)
  }
  const acceleration=ratios.length>=3?median(ratios):null
  const reasons:string[]=[]
  if(observed.length<30)reasons.push(`合格来源去重样本 ${observed.length}/30 条`)
  if(eligible.length<3)reasons.push(`合格出版来源 ${eligible.length}/3 个（每源至少 5 条）`)
  const ready=reasons.length===0
  const words=[...new Set(observed.flatMap(r=>r.words))].slice(0,8)
  const inputs:NarrativeInputs={windowDays:days,articles:window.length,classified:classified.length,positive,negative,
    moneyShare:money??0,sentimentSkew:classified.length?(positive-negative)/classified.length:null,
    optimism:positiveRate===null?null:positiveRate*100,concentration:hhi,acceleration,
    fomo:{score:round((chase??0)*100),hits:words,exclaimDensity:0,breadth:chase??0,depth:0,articles:observed.length},
    latestDate:window.at(-1)?.publishedAt.slice(0,10)??null}
  const factor=(key:string,label:string,value:number|null,unit:string,note:string,coverage:string):EvidenceFactor=>({key,label,value:value===null?null:round(value),score:null,weight:0,unit,
    display:value===null?'资料不足':`${key==='acceleration'&&value>=0?'+':''}${round(value)}${unit}`,note,coverage})
  return {model:NARRATIVE_MODEL,status:ready?'ready':'insufficient',windowDays:days,score:ready?round(capital!*100):null,band:'unknown',
    fomo:inputs.fomo,inputs,reasons,
    formula:'先按 URL 与源内规范化标题去重，再对每个合格出版源计算（融资/上市 ∪ 金融追逐措辞）报道占比，最后源间等权。交集只计一次。',
    note:'这个百分比描述已覆盖报道中命中资本措辞规则的比例，不是泡沫概率；普通正面新闻、集中报道或技术性能提升不会自动加分。只用原始标题/摘要判定资本措辞，不把后来修改的 AI 分类倒灌进历史。无法识别所有跨源转载，来源与规则误判仍可能影响测量。',
    sampling:{rawArticles:raw.filter(r=>Date.parse(r.publishedAt)>=now-days*DAY).length,uniqueArticles:window.length,eligibleArticles:observed.length,
      publishers:groups.size,eligiblePublishers:eligible.length,entityCoverage:round(entityCoverage,3),momentumPublishers:ratios.length},
    factors:[factor('money','融资 / 上市报道',money===null?null:money*100,'%', '合格出版源等权后的报道比例；不以“上市公司”或技术系列 Series 作为融资命中。',`${eligible.length} 个来源`),
      factor('fomo','金融追逐措辞',chase===null?null:chase*100,'%', '标题/原始摘要中非否定的金融追逐语言；不计性能 10x、产品售罄和普通感叹号。',`${eligible.length} 个来源`),
      factor('sentiment','正面情感占比',positiveRate===null?null:positiveRate*100,'%', '仅用于解释，不进入资本叙事占比；正面技术消息不等于泡沫。',`${sentimentSources.length} 个已标注来源`),
      factor('concentration','实体注意力集中',hhi===null?null:hhi*100,' /100', '源均衡 HHI：实体提及份额平方和；同篇重复实体去重、别名合并。集中不直接代表危险，不进入总数。',`实体覆盖 ${round(entityCoverage*100)}%`),
      factor('acceleration','共同来源报道变化',acceleration===null?null:(acceleration-1)*100,'%', '近 7 天/前 7 天相同出版源的文章数比，取中位数。每期每源至少 10 条、3 个活跃日，至少 3 源；不进入总数。',`${ratios.length} 个可比来源`)],
    partitions:[{key:'capital_only',label:'仅融资/上市',contribution:round((rate(r=>r.money&&!r.chase)??0)*100,3),note:'互斥部分，源间等权'},
      {key:'chase_only',label:'仅追逐措辞',contribution:round((rate(r=>r.chase&&!r.money)??0)*100,3),note:'互斥部分，源间等权'},
      {key:'overlap',label:'两者同时出现',contribution:round((rate(r=>r.chase&&r.money)??0)*100,3),note:'交集只计算一次'}]}
}
