import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { buildDailyValuation, monthlyReference, percentileIn, type ValuationPoint } from '../src/market/valuation.ts'
import { splitFactor, syncSplits, loadSplitHistory } from '../src/market/splits.ts'
import { deriveMetrics } from '../src/market/fundamentals.ts'
import { companyOf } from '../src/market/universe.ts'
import { parseCompanyFacts } from '../src/market/sec.ts'
import { buildMarketOverview } from '../src/market/overview.ts'

const schema = readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8')
const basis = {fiscalEnd:'2023-12-31',filedAt:'2024-02-01',revenue:1000,netIncome:100,equity:500,epsDiluted:1,shares:100,sharesAsOf:'2023-12-31',sharesFiledAt:'2024-02-01'}

test('拆股：复权价格必须配同基准股本；拆股前后市值/P/S/P/E保持一致',()=>{
  const prices=[{date:'2024-05-31',close:10},{date:'2024-06-11',close:10}]
  const series=buildDailyValuation(prices,[basis],{splits:[{date:'2024-06-10',numerator:10,denominator:1}]})
  assert.equal(series[0].marketCap,10000)
  assert.equal(series[1].marketCap,10000)
  assert.equal(series[0].ps,10)
  assert.equal(series[0].pe,100)
  assert.equal(series[0].basis?.splitFactor,10)
})

test('拆股：使用申报股本单位日期，不重复调整已重列版本；支持反向拆股',()=>{
  const splits=[{date:'2021-07-20',numerator:4,denominator:1},{date:'2024-06-10',numerator:10,denominator:1}]
  assert.equal(splitFactor(splits,'2020-01-01','2024-06-11'),40)
  assert.equal(splitFactor(splits,'2024-06-12','2024-06-13'),1)
  assert.equal(splitFactor([{date:'2024-06-10',numerator:1,denominator:10}],'2024-01-01','2024-06-11'),0.1)
  assert.equal(splitFactor(splits,'2024-01-01','2024-06-01'),1)
})

test('P/E：与P/S使用同一市值，不把不一致的EPS单位混进分母',()=>{
  const point=buildDailyValuation([{date:'2024-03-01',close:10}],[{...basis,epsDiluted:0.1}])[0]
  assert.equal(point.pe,10)
  assert.equal(point.basis?.shareBasisReliable,false)
  assert.equal(buildDailyValuation([{date:'2024-03-01',close:10}],[{...basis,netIncome:-10}])[0].pe,null)
})

function history(months:number):ValuationPoint[]{
  return Array.from({length:months},(_,i)=>({date:new Date(Date.UTC(2024,0+i,28)).toISOString().slice(0,10),close:10,marketCap:1000,ps:10,pe:20,
    basis:{fiscalEnd:'2023-12-31',filedAt:'2024-02-01',pitReliable:true,splitFactor:1,sharesAsOf:'2023-12-31',sharesFiledAt:'2024-02-01',shareBasisReliable:true,financialAgeDays:100}}))
}
test('月末分位：24个月门槛，当月不入基准，并列取中位秩',()=>{
  const current={...history(1)[0],date:'2026-02-10'}
  assert.equal(monthlyReference(history(23),current,true).psPercentile,null)
  const result=monthlyReference([...history(24),{...current,ps:999}],current,true)
  assert.equal(result.months,24)
  assert.equal(result.psPercentile,0.5)
  assert.equal(result.pePercentile,0.5)
  assert.equal(percentileIn(10,Array(60).fill(10)),0.5)
})
test('历史参照：未核验、补录、过旧财报不能混进参照',()=>{
  const rows=history(25),current={...rows[0],date:'2026-03-10'}
  assert.equal(monthlyReference(rows,current,false).months,0)
  rows[0].manual=true
  rows[1].basis!.shareBasisReliable=false
  rows[2].basis!.financialAgeDays=551
  assert.equal(monthlyReference(rows,current,true).months,22)
})

test('历史参照：无效月末不得回退到月中，区间仅由有效P/S月份决定',()=>{
  const rows=history(24),current={...rows[0],date:'2026-02-10'}
  rows.push({...rows[0],date:'2024-01-30',manual:true})
  const result=monthlyReference(rows,current,true)
  assert.equal(result.months,23)
  assert.equal(result.from,'2024-02-28')
  assert.equal(result.psPercentile,null)
})

test('财报派生：排除未来申报、按财年去重，跨年缺档不冒充同比',()=>{
  const company=companyOf('NVDA')!
  const row={...basis,fiscalEnd:'2022-12-31',filedAt:'2023-02-01'}
  const result=deriveMetrics(company,[row,{...row,filedAt:'2023-03-01'}, {...basis,fiscalEnd:'2024-12-31',filedAt:'2025-02-01'},
    {...basis,fiscalEnd:'2025-12-31',filedAt:'2026-02-01'}],'2025-12-01')
  assert.equal(result.years,2)
  assert.equal(result.latest?.fiscalEnd,'2024-12-31')
  assert.equal(result.revenueGrowth,null)
})

test('SEC解析：权益/股本不得读取晚于年报版本的后续申报事实',()=>{
  const annual={start:'2023-01-01',end:'2023-12-31',filed:'2024-02-01',val:1000,form:'10-K'}
  const json={facts:{'us-gaap':{
    Revenues:{units:{USD:[annual]}}, NetIncomeLoss:{units:{USD:[{...annual,val:100}]}},
    EarningsPerShareDiluted:{units:{'USD/shares':[{...annual,val:1}]}},
    CommonStockSharesOutstanding:{units:{shares:[{end:'2023-12-31',filed:'2024-02-01',val:100},{end:'2023-12-31',filed:'2025-02-01',val:1000}]}},
    StockholdersEquity:{units:{USD:[{end:'2023-12-31',filed:'2024-02-01',val:500},{end:'2023-12-31',filed:'2025-02-01',val:999}]}},
  }}}
  const row=parseCompanyFacts(json).annual[0]
  assert.equal(row.shares,100);assert.equal(row.equity,500);assert.equal(row.sharesFiledAt,'2024-02-01')
})

test('拆股同步：失败保留上次核验，首次核验与变更触发历史复权重拉',async t=>{
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close())
  process.env.FMP_API_KEY='test-only-placeholder'
  let fail=false
  t.mock.method(globalThis,'fetch',async()=>fail?new Response('unavailable',{status:503}):Response.json([{date:'2024-06-10',numerator:10,denominator:1}]))
  const first=await syncSplits(db,{only:['NVDA']})
  assert.deepEqual(first.changed,['NVDA'])
  assert.deepEqual((await syncSplits(db,{only:['NVDA']})).changed,[])
  const checked=loadSplitHistory(db,'NVDA').checkedAt
  fail=true;await syncSplits(db,{only:['NVDA']})
  assert.equal(loadSplitHistory(db,'NVDA').checkedAt,checked)
  assert.equal(loadSplitHistory(db,'NVDA').splits.length,1)
})

test('估值装配：未核验不给精确结论，基准指数最新日期不掩盖公司旧行情',t=>{
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close())
  db.prepare('INSERT INTO equity_daily(symbol,date,close)VALUES(?,?,?)').run('NVDA','2026-11-01',10)
  db.prepare('INSERT INTO equity_daily(symbol,date,close)VALUES(?,?,?)').run('QQQ','2026-11-14',100)
  const result=buildMarketOverview(db,{now:Date.parse('2026-11-14T12:00:00Z')})
  const nvda=result.companies.find(c=>c.symbol==='NVDA')!
  assert.equal(nvda.ps,null);assert.equal(nvda.relativeScore,null);assert.equal(nvda.valuationState,'blocked')
  assert.equal(result.freshness.priceUntil,'2026-11-01')
  assert.equal(result.freshness.status,'stale')
})

test('估值装配：详情与倍数使用报价日可见的同一财报，不能混入次日新申报',t=>{
  const db=new DatabaseSync(':memory:');db.exec(schema);t.after(()=>db.close())
  db.prepare('INSERT INTO equity_daily(symbol,date,close)VALUES(?,?,?)').run('NVDA','2026-11-13',10)
  db.prepare('INSERT INTO market_split_history(symbol,splits,checked_at)VALUES(?,?,?)').run('NVDA','[]','2026-11-14T00:00:00Z')
  const insert=db.prepare(`INSERT INTO company_fundamentals(symbol,fiscal_end,filed_at,revenue,net_income,shares,shares_as_of,shares_filed_at,pit_reliable,updated_at)VALUES('NVDA',?,?,?,?,?,?,?,1,?)`)
  insert.run('2025-12-31','2026-02-01',1000,100,100,'2025-12-31','2026-02-01','2026-11-14')
  insert.run('2026-10-31','2026-11-14',2000,200,100,'2026-10-31','2026-11-14','2026-11-14')
  const row=buildMarketOverview(db,{now:Date.parse('2026-11-14T12:00:00Z')}).companies.find(c=>c.symbol==='NVDA')!
  assert.equal(row.fiscalEnd,'2025-12-31');assert.equal(row.revenue,1000);assert.equal(row.ps,1)
  assert.equal(row.basis?.fiscalEnd,row.fiscalEnd)
})
