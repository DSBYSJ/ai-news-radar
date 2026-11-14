import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import {narrativeEvidence,chaseLanguage} from '../src/risk/narrativeEvidence.ts'
import {marketPressure} from '../src/risk/pressure.ts'
import {riskReport} from '../src/risk/index.ts'
import {backfillRisk} from '../src/risk/backfill.ts'
import type {MacroSnapshot,MacroPoint} from '../src/risk/macro.ts'

const schema=readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8')
const NOW=Date.parse('2026-11-14T12:00:00Z'),DAY=86400000
function setup(t:{after:(fn:()=>void)=>void}){
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close())
  db.prepare("INSERT INTO sources(id,name,url,kind)VALUES('s','fixture','https://example.com','rss')").run()
  return db
}
let id=0
function add(db:DatabaseSync,publisher:number,opts:{title?:string;daysAgo?:number;category?:string;sentiment?:string;entities?:string;url?:string;createdAt?:number;fetchedAt?:number}={}){
  const key=++id,at=new Date(NOW-(opts.daysAgo??1)*DAY).toISOString(),title=opts.title??`${opts.category==='funding'?'Funding announcement':'Ordinary model update'} ${key}`
  const url=opts.url??`https://publisher${publisher}.example.com/story/${key}`
  db.prepare(`INSERT INTO raw_items(id,source_id,guid,url,url_norm,title,summary,published_at,fingerprint,fetched_at)VALUES(?,'s',?,?,?,?,'',?,?,?)`)
    .run(key,String(key),url,url,title,at,String(key),new Date(opts.fetchedAt??Date.parse(at)).toISOString())
  db.prepare(`INSERT INTO articles(id,raw_id,url,title,category,sentiment,entities,published_at,created_at)VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(key,key,url,title,opts.category??'other',opts.sentiment??'positive',opts.entities??'["NVIDIA"]',at,new Date(opts.createdAt??Date.parse(at)).toISOString())
}
function point(key:string,values:number[],dates:string[]):MacroPoint{return{key,label:key,value:values.at(-1)!,asOf:dates.at(-1)!,history:[...values],dates:[...dates],yearAgo:null,avg200:null,high52w:null,source:'fixture'}}
function macro(count=900):MacroSnapshot{
  const dates=Array.from({length:1400},(_,i)=>new Date(NOW-(1399-i)*DAY)).filter(d=>![0,6].includes(d.getUTCDay())).slice(-count).map(d=>d.toISOString().slice(0,10))
  return{available:true,missing:[],notes:[],inversion:false,fetchedAt:new Date(NOW).toISOString(),series:{
    creditSpread:point('creditSpread',dates.map(()=>3),dates),nasdaq:point('nasdaq',dates.map(()=>100),dates)}}
}

test('V3 新闻：按出版源等权，一家来源大量发稿不会支配全站占比',t=>{
  const db=setup(t)
  for(let source=1;source<=3;source++)for(let i=0;i<10;i++)add(db,source,{category:source===1?'funding':'other'})
  const before=narrativeEvidence(db,{now:NOW})
  assert.equal(before.score,33.3)
  for(let i=0;i<100;i++)add(db,1,{category:'funding'})
  assert.equal(narrativeEvidence(db,{now:NOW}).score,before.score)
})
test('V3 新闻：URL/源内标题去重，追踪参数和重复 RSS 不增加样本或占比',t=>{
  const db=setup(t)
  for(let source=1;source<=3;source++)for(let i=0;i<10;i++)add(db,source,{title:`融资事件 ${source} ${i}`,category:'funding'})
  const before=narrativeEvidence(db,{now:NOW})
  for(let i=0;i<50;i++)add(db,1,{title:'融资事件 1 0',category:'funding'})
  assert.equal(narrativeEvidence(db,{now:NOW}).sampling.uniqueArticles,before.sampling.uniqueArticles)
  assert.equal(narrativeEvidence(db,{now:NOW}).score,before.score)
})
test('V3 新闻：融资与追逐取并集，交集不重复计分；正面和集中不另加分',t=>{
  const db=setup(t)
  for(let source=1;source<=3;source++)for(let i=0;i<10;i++)add(db,source,{title:`${i<3||i===5||i===6?'funding':'normal'} ${i>=3&&i<=6?'must-buy stock':'normal'} news ${source} ${i}`,category:i<3||i===5||i===6?'funding':'other',entities:'["NVIDIA","英伟达","NVIDIA"]'})
  const result=narrativeEvidence(db,{now:NOW})
  assert.equal(result.score,70)
  assert.equal(result.partitions.reduce((sum,p)=>sum+p.contribution,0),70)
  assert.equal(result.factors.find(f=>f.key==='concentration')?.value,100)
  assert.equal(result.factors.find(f=>f.key==='sentiment')?.value,100)
  assert.ok(result.factors.every(f=>f.score===null&&f.weight===0))
})
test('V3 措辞：技术 10x/售罄/感叹号、series 和上市公司不是投资狂热',t=>{
  assert.equal(chaseLanguage('GPU 10x faster! sold out! 新产品售罄！！').hit,false)
  assert.equal(chaseLanguage('避免踏空、警惕抢筹。Avoid FOMO. Not a must-buy stock.').hit,false)
  assert.equal(chaseLanguage('最后上车！This is a must-buy stock').hit,true)
  assert.equal(chaseLanguage('Normal market commentary: a must-buy stock').hit,true)
  const db=setup(t)
  for(let source=1;source<=3;source++)for(let i=0;i<10;i++)add(db,source,{title:`上市公司发布 GPU series 推理 10x faster ${source} ${i}`})
  assert.equal(narrativeEvidence(db,{now:NOW}).score,0)
})
test('V3 新闻：排除同日未来文章、以后加工或以后补采的旧新闻',t=>{
  const db=setup(t)
  for(let source=1;source<=3;source++)for(let i=0;i<10;i++)add(db,source)
  const before=narrativeEvidence(db,{now:NOW})
  for(let i=0;i<10;i++){
    add(db,1,{category:'funding',daysAgo:-.01})
    add(db,1,{category:'funding',createdAt:NOW+DAY})
    add(db,1,{category:'funding',fetchedAt:NOW+DAY})
  }
  assert.deepEqual(narrativeEvidence(db,{now:NOW}),before)
})
test('V3 新闻：单源或有效样本不足时不把占比当成全站测量',t=>{
  const db=setup(t)
  for(let i=0;i<100;i++)add(db,1,{category:'funding'})
  const result=narrativeEvidence(db,{now:NOW})
  assert.equal(result.score,null);assert.equal(result.status,'insufficient')
})
test('V3 热度：新增来源不制造增速；真实共同来源四倍增长也不机械丢弃',t=>{
  const db=setup(t)
  for(let source=1;source<=3;source++){
    for(let i=0;i<10;i++)add(db,source,{daysAgo:7.5+i%6})
    for(let i=0;i<40;i++)add(db,source,{daysAgo:.5+i%6})
  }
  for(let i=0;i<100;i++)add(db,4,{daysAgo:1+i%5})
  const result=narrativeEvidence(db,{now:NOW})
  assert.equal(result.inputs.acceleration,4)
  assert.equal(result.sampling.momentumPublishers,3)
  assert.equal(result.factors.find(f=>f.key==='acceleration')?.value,300)
})
test('V3 实体：覆盖不足时不把少数抽取结果冒充全体集中度',t=>{
  const db=setup(t)
  for(let source=1;source<=3;source++)for(let i=0;i<10;i++)add(db,source,{entities:i<2?'["NVIDIA"]':'[]'})
  assert.equal(narrativeEvidence(db,{now:NOW}).inputs.concentration,null)
})
test('V3 压力：并列取中位秩，常数背景为50；不计算危机概率',async t=>{
  const result=marketPressure(macro(),{now:NOW})
  assert.equal(result.score,50);assert.equal(result.factors.length,4)
  assert.ok(result.factors.every(f=>f.score===50&&f.weight===25&&f.referenceUntil<result.asOf!))
  const report=await riskReport(setup(t),{now:NOW,macro:macro()})
  assert.equal(report.crisis?.probability12m,null)
  assert.ok(!report.crisis?.factors.some(f=>f.key==='narrative'))
})
test('V3 压力：新闻、名义利率、倒挂不污染同一市场资料的读数',async t=>{
  const db=setup(t),data=macro(),before=await riskReport(db,{now:NOW,macro:data})
  for(let source=1;source<=3;source++)for(let i=0;i<10;i++)add(db,source,{category:'funding'})
  data.inversion=true;data.series.rates10y=point('rates10y',[8],['2026-11-13'])
  const after=await riskReport(db,{now:NOW,macro:data})
  assert.equal(after.nfi?.score,100);assert.equal(after.pressure.score,before.pressure.score)
})
test('V3 压力：利差扩大、回撤和波动的联合冲击提高读数',()=>{
  const data=macro(),baseline=marketPressure(data,{now:NOW})
  data.series.creditSpread.history[data.series.creditSpread.history.length-1]=10;data.series.creditSpread.value=10
  data.series.nasdaq.history[data.series.nasdaq.history.length-1]=70;data.series.nasdaq.value=70
  const result=marketPressure(data,{now:NOW})
  assert.ok(result.score!>baseline.score!);assert.equal(result.score,100)
})
test('V3 压力：共同观测日期对齐，单侧更新不能当成同一天的联合测量',()=>{
  const data=macro(),date=data.series.nasdaq.dates.at(-2)!
  data.series.nasdaq.history.pop();data.series.nasdaq.dates=data.series.nasdaq.dates.slice(0,-1);data.series.nasdaq.asOf=date
  const result=marketPressure(data,{now:NOW})
  assert.equal(result.asOf,date);assert.equal(result.score,50)
})
test('V3 压力：不足252个派生历史、过期、超前和数据冲突都暂停，不按余项归一',()=>{
  assert.equal(marketPressure(macro(400),{now:NOW}).score,null)
  assert.equal(marketPressure(macro(),{now:NOW+15*DAY}).score,null)
  const future=macro();future.series.creditSpread.asOf='2026-11-15'
  assert.equal(marketPressure(future,{now:NOW}).score,null)
  const conflict=macro();conflict.series.creditSpread.history.push(100);conflict.series.creditSpread.dates.push(conflict.series.creditSpread.asOf)
  assert.equal(marketPressure(conflict,{now:NOW}).score,null)
})
test('V3 压力：当前不入历史基准，追加未到观测不改变过去读数',()=>{
  const data=macro(),before=marketPressure(data,{now:NOW})
  for(const key of ['creditSpread','nasdaq']){data.series[key].history.push(999);data.series[key].dates.push('2026-11-16')}
  assert.deepEqual(marketPressure(data,{now:NOW}),before)
})
test('V3 历史：单独版本/窗口保存，不覆盖旧版或其他窗口；未计算保留null',t=>{
  const db=setup(t)
  db.prepare("INSERT INTO risk_daily(date,nfi,crs,created_at)VALUES('2026-11-14',42,42,'2026-11-14')").run()
  db.prepare("INSERT INTO risk_snapshots(date,window_days,model,nfi,crs,created_at)VALUES('2026-11-14',90,'risk-evidence-v3',90,90,'2026-11-14')").run()
  backfillRisk(db,{days:7,windowDays:30,now:NOW,apply:true})
  assert.equal(db.prepare("SELECT nfi FROM risk_daily").get()!.nfi,42)
  assert.equal(db.prepare("SELECT nfi FROM risk_snapshots WHERE window_days=90").get()!.nfi,90)
  const row=db.prepare("SELECT nfi,crs FROM risk_snapshots WHERE window_days=30 AND date='2026-11-14'").get()!
  assert.equal(row.nfi,null);assert.equal(row.crs,null)
})
