import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { parseFinancialFacts, financialBasisAt, type FinancialFact } from '../src/market/financialFacts.ts'
import { buildEvidenceValuation,evidenceReference } from '../src/market/valuationEvidence.ts'
import { buildMarketOverview } from '../src/market/overview.ts'

const A='0000000001-25-000001', B='0000000001-26-000001', C='0000000001-26-000002'
function fact(metric:FinancialFact['metric'],start:string|null,end:string,filed:string,value:number,accession=B):FinancialFact {
  return {metric,start,end,filed,value,accession,form:'10-K',tag:metric==='revenue'?'us-gaap:Revenues':metric==='netIncome'?'us-gaap:NetIncomeLoss':'dei:EntityCommonStockSharesOutstanding',
    unit:metric==='shares'?'shares':'USD',url:`https://www.sec.gov/Archives/edgar/data/1/${accession.replaceAll('-','')}/${accession}-index.html`}
}
function input():FinancialFact[] {
  return [fact('revenue','2025-01-01','2025-12-31','2026-02-01',1000),fact('netIncome','2025-01-01','2025-12-31','2026-02-01',100),
    fact('revenue','2026-01-01','2026-06-30','2026-08-01',700,C),fact('netIncome','2026-01-01','2026-06-30','2026-08-01',90,C),
    fact('revenue','2025-01-01','2025-06-30','2026-08-01',400,C),fact('netIncome','2025-01-01','2025-06-30','2026-08-01',30,C),
    fact('shares',null,'2026-07-25','2026-08-01',100,C)]
}
test('TTM：上年全年 + 本期累计 − 上年同期，分母与原始申报逐段可追溯',()=>{
  const f=financialBasisAt(input(),'2026-08-02')!
  assert.equal(f.kind,'ttm');assert.equal(f.revenue,1300);assert.equal(f.netIncome,160)
  assert.equal(f.periodStart,'2025-07-01');assert.equal(f.periodEnd,'2026-06-30')
  assert.equal(f.components.length,3);assert.ok(f.components.every(x=>x.netIncome?.accession===x.revenue.accession))
})
test('申报时点：当日收盘不能偷看未知接收时刻的申报，更晚重述不改过去',()=>{
  assert.equal(financialBasisAt(input(),'2026-08-01')!.kind,'annual')
  const prior=financialBasisAt(input(),'2026-08-02')
  const future=[...input(),fact('revenue','2026-01-01','2026-06-30','2026-09-01',9999,A)]
  assert.deepEqual(financialBasisAt(future,'2026-08-02'),prior)
})
test('TTM：单季度不乘四，不混不同营收标签或不同累计长度',()=>{
  const missing=input().filter(f=>!(f.metric==='revenue'&&f.end==='2025-06-30'))
  assert.equal(financialBasisAt(missing,'2026-08-02')!.kind,'annual')
  const changed=input().map(f=>f.metric==='revenue'&&f.end==='2026-06-30'?{...f,tag:'us-gaap:SalesRevenueNet'}:f)
  assert.equal(financialBasisAt(changed,'2026-08-02')!.kind,'annual')
  const wrongPeriod=input().map(f=>f.metric==='revenue'&&f.end==='2025-06-30'?{...f,end:'2025-03-31'}:f)
  assert.equal(financialBasisAt(wrongPeriod,'2026-08-02')!.kind,'annual')
})
test('净利必须与各段营收同申报同标签，亏损不能变成正 P/E',()=>{
  const mismatch=input().map(f=>f.metric==='netIncome'&&f.end==='2026-06-30'?{...f,accession:A}:f)
  assert.equal(financialBasisAt(mismatch,'2026-08-02')!.netIncome,null)
  const loss=input().map(f=>f.metric==='netIncome'?{...f,value:-Math.abs(f.value)}:f)
  assert.equal(buildEvidenceValuation([{date:'2026-08-03',close:13}],loss,[],'2026-08-03')[0].pe,null)
})
test('SEC 原始事实：外币、缺编号、无效日期和同申报冲突值均不进入模型',()=>{
  const raw={start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',accn:B,form:'10-K',val:1000}
  const parse=(rows:typeof raw[],unit='USD')=>parseFinancialFacts({facts:{'us-gaap':{Revenues:{units:{[unit]:rows}}}}},'1')
  assert.equal(parse([raw]).length,1);assert.equal(parse([raw],'TWD').length,0)
  assert.equal(parse([{...raw,accn:''}]).length,0);assert.equal(parse([{...raw,end:'2025-02-30'}]).length,0)
  assert.equal(parse([raw,{...raw,val:999}]).length,0)
  assert.equal(parse([raw,{...raw}]).length,1)
})
test('总股本：冲突的股数不猜测合并，过旧与拆股期间不明确的股本暂停',()=>{
  const conflicting=[...input(),{...input().at(-1)!,tag:'us-gaap:CommonStockSharesOutstanding',value:10}]
  assert.equal(financialBasisAt(conflicting,'2026-08-03')!.shares,null)
  const old=input().map(f=>f.metric==='shares'?{...f,end:'2024-01-01'}:f)
  assert.equal(financialBasisAt(old,'2026-08-03')!.shares,null)
  const split=[{date:'2026-07-28',numerator:10,denominator:1}]
  assert.equal(buildEvidenceValuation([{date:'2026-08-03',close:13}],input(),split,'2026-08-03')[0].basis!.shareBasisReliable,false)
})
test('拆股：申报前单位明确时，历史报价与股本统一到同一复权基准',()=>{
  const splits=[{date:'2026-08-10',numerator:10,denominator:1}]
  const point=buildEvidenceValuation([{date:'2026-08-03',close:1.3}],input(),splits,'2026-08-11')[0]
  assert.equal(point.marketCap,1300);assert.equal(point.ps,1)
  assert.equal(point.pe,1300/160)
})
test('历史分布：拒绝月中冒充月末，排除当前月、手工报价及不同财务口径',()=>{
  const source=buildEvidenceValuation([{date:'2026-08-03',close:13}],input(),[],'2026-08-03')[0]
  const months=Array.from({length:26},(_,i)=>({...source,date:new Date(Date.UTC(2024,i+1,0)).toISOString().slice(0,10)}))
  const current={...source,date:'2026-08-03'}
  assert.equal(evidenceReference(months,current,true).ps.percentile,.5)
  months[0]={...months[0],date:'2024-01-15'};months[1]={...months[1],manual:true}
  months[2]={...months[2],financial:{...months[2].financial,kind:'annual'}}
  const r=evidenceReference([...months,{...current,ps:999}],current,true)
  assert.equal(r.ps.months,23);assert.equal(r.ps.percentile,null)
})
test('P/E 参照只用盈利子样本，与 P/S 月份数和参考区间分别返回',()=>{
  const base=buildEvidenceValuation([{date:'2026-08-03',close:13}],input(),[],'2026-08-03')[0]
  const rows=Array.from({length:26},(_,i)=>({...base,date:new Date(Date.UTC(2024,i+1,0)).toISOString().slice(0,10),pe:i<3?null:base.pe}))
  const r=evidenceReference(rows,base,true)
  assert.equal(r.ps.months,26);assert.equal(r.pe.months,23);assert.equal(r.ps.percentile,.5);assert.equal(r.pe.percentile,null)
  assert.notEqual(r.ps.from,r.pe.from)
})
test('正式装配：两种分位不混成总分，手工报价不冒充可靠自动估值',t=>{
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));t.after(()=>db.close())
  db.prepare('INSERT INTO market_financial_facts VALUES(?,?,?)').run('NVDA',JSON.stringify(input()),'2026-08-03')
  db.prepare('INSERT INTO equity_daily(symbol,date,close)VALUES(?,?,?)').run('NVDA','2026-08-03',13)
  db.prepare('INSERT INTO market_split_history VALUES(?,?,?)').run('NVDA','[]','2026-08-03T12:00:00Z')
  const overview=()=>buildMarketOverview(db,{now:Date.parse('2026-08-03T14:00:00Z')}).companies.find(c=>c.symbol==='NVDA')!
  assert.equal(overview().ps,1);assert.equal(overview().relativeScore,null);assert.equal(overview().financial?.revenue,1300)
  db.prepare('INSERT INTO manual_price VALUES(?,?,?,?,?)').run('NVDA','2026-08-03',20,'test','2026-08-03')
  assert.equal(overview().ps,null);assert.ok(overview().reasons.some(x=>x.includes('手工')))
})
