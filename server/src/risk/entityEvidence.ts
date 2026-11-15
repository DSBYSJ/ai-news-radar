import type { DatabaseSync } from 'node:sqlite'
import { normalizeUrl } from '../collector/fingerprint.ts'
import { publisherOf } from './events.ts'
import { UNIVERSE } from '../market/universe.ts'

export interface EntityEvidence {
  entity:string;negative:number;mentions:number;negativeShare:number;heatChange:number|null;funding:number;score:number;reason:string
  classified:number;coverage:number;publishers:number;balancedShare:number|null;negativeChange:number|null
}
/** Descriptive, labelled-news proportion; no arbitrary vulnerability score or unknown-as-neutral. */
export function entityEvidence(db:DatabaseSync,days:number,now:number,limit=10):EntityEvidence[] {
  const day=86_400_000
  const rows=db.prepare(`SELECT m.entity,a.id,a.sentiment,r.url,r.title,a.published_at AS at FROM mentions m
    JOIN articles a ON a.id=m.article_id JOIN raw_items r ON r.id=a.raw_id
    WHERE a.ai_relevant=1 AND julianday(a.published_at)>=julianday(?) AND julianday(a.published_at)<=julianday(?)
      AND julianday(a.created_at)<=julianday(?) AND julianday(r.fetched_at)<=julianday(?) ORDER BY a.published_at,a.id`)
    .all(new Date(now-Math.max(days,14)*day).toISOString(),...Array(3).fill(new Date(now).toISOString())) as unknown as {entity:string;id:number;sentiment:string|null;url:string;title:string;at:string}[]
  const groups=new Map<string,typeof rows>(),seen=new Set<string>()
  for(const row of rows) {
    const company=UNIVERSE.find(c=>[c.symbol,c.name,...c.aliases].some(s=>s.toLowerCase()===row.entity.toLowerCase()))
    const entity=company?.name??row.entity,source=publisherOf(row.url,row.title)
    const keys=[`${entity}|url:${normalizeUrl(row.url)}`,`${entity}|${source}|${row.title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')}`]
    if(keys.some(k=>seen.has(k)))continue
    keys.forEach(k=>seen.add(k));const bucket=groups.get(entity)??[];bucket.push(row);groups.set(entity,bucket)
  }
  const output:EntityEvidence[]=[]
  const labelled=(r:typeof rows[number])=>['negative','neutral','positive'].includes(r.sentiment??'')
  for(const [entity,all] of groups) {
    const current=all.filter(r=>Date.parse(r.at)>=now-days*day),labels=current.filter(labelled),negative=labels.filter(r=>r.sentiment==='negative').length
    if(current.length<3||!negative)continue
    const sources=new Map<string,typeof rows>()
    for(const r of labels){const source=publisherOf(r.url,r.title),bucket=sources.get(source)??[];bucket.push(r);sources.set(source,bucket)}
    const eligible=[...sources.values()].filter(rs=>rs.length>=3),coverage=labels.length/current.length
    const balancedShare=eligible.length>=2&&coverage>=.6?eligible.reduce((s,rs)=>s+rs.filter(r=>r.sentiment==='negative').length/rs.length,0)/eligible.length:null
    const changes:number[]=[]
    for(const rs of sources.values()) {
      const recent=rs.filter(r=>Date.parse(r.at)>=now-7*day),prior=rs.filter(r=>Date.parse(r.at)<now-7*day&&Date.parse(r.at)>=now-14*day)
      if(recent.length>=3&&prior.length>=3)changes.push(recent.filter(r=>r.sentiment==='negative').length/recent.length-prior.filter(r=>r.sentiment==='negative').length/prior.length)
    }
    output.push({entity,negative,mentions:current.length,classified:labels.length,coverage,publishers:eligible.length,balancedShare,
      negativeShare:labels.length?negative/labels.length:0,negativeChange:changes.length>=2?changes.reduce((a,b)=>a+b,0)/changes.length:null,
      score:balancedShare===null?0:Math.round(balancedShare*100),funding:0,heatChange:null,
      reason:balancedShare===null?'情绪覆盖或出版源样本不足，仅列原始计数':'各出版源内已标注报道负面占比的等权平均'})
  }
  return output.sort((a,b)=>(b.balancedShare??-1)-(a.balancedShare??-1)||b.negative-a.negative).slice(0,limit)
}
