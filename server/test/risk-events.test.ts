import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { eventRisk } from '../src/risk/events.ts'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8')
function setup(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  t.after(() => db.close())
  return db
}
function add(db: DatabaseSync, n: number, title: string, opts: { url?: string; hours?: number; summary?: string } = {}) {
  const url = opts.url ?? `https://example.com/${n}`
  const at = new Date(NOW - (opts.hours ?? 1) * 3_600_000).toISOString()
  db.prepare('INSERT OR IGNORE INTO sources (id,name,url,kind) VALUES (?,?,?,?)').run(`s${n}`, `Feed ${n}`, url, 'rss')
  db.prepare('INSERT INTO raw_items (source_id,guid,url,url_norm,title,summary,published_at,fingerprint,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`s${n}`, String(n), url, url, title, opts.summary ?? '', at, String(n), at)
}

test('重大领导变动直接扫描原始新闻，不受 AI 未加工和空实体影响', (t) => {
  const db = setup(t)
  add(db, 1, 'NVIDIA Announces CEO Transition', { url: 'https://nvidianews.nvidia.com/news/transition', hours: 48 })
  const r = eventRisk(db, { now: NOW })
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].symbol, 'NVDA')
  assert.equal(r.events[0].confidence, 'official')
  assert.ok(r.score! >= 55)
  assert.equal(r.status, 'elevated')
})

test('同一出版来源多个 RSS/同 URL 转载不会堆高强度', (t) => {
  const db = setup(t)
  add(db, 1, 'Nvidia CEO Jensen Huang resigns', { url: 'https://techcrunch.com/story' })
  const before = eventRisk(db, { now: NOW })
  add(db, 2, 'Nvidia CEO Jensen Huang resigns', { url: 'https://techcrunch.com/story?utm_source=feed' })
  add(db, 3, '黄仁勋辞去英伟达 CEO 职务', { url: 'https://techcrunch.com/followup' })
  const after = eventRisk(db, { now: NOW })
  assert.equal(after.events[0].sources, 1)
  assert.equal(after.events[0].confidence, 'single')
  assert.equal(after.score, before.score)
})

test('可识别为同一通讯社的转载按一份来源证据处理', (t) => {
  const db = setup(t)
  add(db, 1, '路透社：英伟达 CEO 黄仁勋辞职', { url: 'https://one.example/story' })
  add(db, 2, 'Nvidia CEO Jensen Huang resigns - Reuters', { url: 'https://two.example/story' })
  assert.equal(eventRisk(db, { now: NOW }).events[0].sources, 1)
})

test('否认、纯任命、消费品退役、早报与背景摘要不触发新事件', (t) => {
  const db = setup(t)
  for (const [i, title] of ['英伟达否认 CEO 黄仁勋辞职传闻', 'Nvidia CEO is not stepping down',
    '英伟达任命新任高管', '英伟达宣布显卡退役', '早报：黄仁勋辞职 / 新模型发布',
    '英伟达发布新模型'].entries()) add(db, i + 1, title, { summary: 'CEO resigned in 2023; historical background.' })
  assert.equal(eventRisk(db, { now: NOW }).events.length, 0)
})

test('传闻单独列为待核实，不作为已发生冲击计入总强度', (t) => {
  const db = setup(t)
  add(db, 1, '传闻：英伟达 CEO 黄仁勋或将辞职')
  const r = eventRisk(db, { now: NOW })
  assert.equal(r.score, 0)
  assert.equal(r.events.length, 0)
  assert.equal(r.unconfirmed.length, 1)
  assert.ok(r.unconfirmed[0].score <= 35)
})

test('多出版源只增加覆盖，不能证明事实更真；无关新闻不稀释关注度', (t) => {
  const db = setup(t)
  add(db, 1, '黄仁勋辞去英伟达 CEO 职务', { url: 'https://one.example/story' })
  const one = eventRisk(db, { now: NOW })
  add(db, 2, 'Nvidia CEO Jensen Huang resigns', { url: 'https://two.example/story' })
  const two = eventRisk(db, { now: NOW })
  assert.equal(two.score, one.score)
  assert.equal(two.events[0].confidence,'multiple')
  assert.equal(two.events[0].verification,'media_report')
  for (let n = 3; n <= 60; n++) add(db, n, `AI model release ${n}`)
  assert.equal(eventRisk(db, { now: NOW }).score, two.score)
})

test('新转载不重置衰减时钟；未来数据和历史回顾不参与', (t) => {
  const db = setup(t)
  add(db, 1, '英伟达 CEO 黄仁勋辞职', { hours: 96 })
  const old = eventRisk(db, { now: NOW })
  add(db, 2, '英伟达 CEO 黄仁勋辞职', { hours: 1 })
  add(db, 3, 'OpenAI CEO Sam Altman resigns', { hours: -1 })
  add(db, 4, '回顾：OpenAI CEO Sam Altman resigns')
  const r = eventRisk(db, { now: NOW })
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].firstSeen, old.events[0].firstSeen)
  assert.equal(r.score, old.score)
})

test('数据缺失/采集过期时不声称监测正常', (t) => {
  const db = setup(t)
  assert.equal(eventRisk(db, { now: NOW }).status, 'unknown')
  add(db, 1, '普通 AI 新闻', { hours: 80 })
  const r = eventRisk(db, { now: NOW })
  assert.equal(r.stale, true)
  assert.equal(r.status, 'unknown')
})

test('领导层变动归属正确公司，不把回应方也判为发生离任', (t) => {
  const db = setup(t)
  add(db, 1, '微软回应 OpenAI CEO Sam Altman 辞职消息')
  add(db, 2, '微软回应 OpenAI CEO 辞职消息')
  const r = eventRisk(db, { now: NOW })
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].entity, 'OpenAI')
})

test('否认与相反表述进入争议观察，不能只过滤否认却继续给原报道计分',t=>{
  const db=setup(t)
  add(db,1,'Nvidia CEO Jensen Huang resigns')
  add(db,2,'英伟达否认 CEO 黄仁勋辞职消息',{url:'https://nvidianews.nvidia.com/news/denial'})
  const r=eventRisk(db,{now:NOW})
  assert.equal(r.score,0);assert.equal(r.events.length,0);assert.equal(r.unconfirmed[0].verification,'disputed')
  assert.ok(r.unconfirmed[0].evidence.some(e=>e.stance==='denied'))
})
test('第三方公司网站或用户论坛不等于当事公司公告，同标题跨域不增加独立证据',t=>{
  const db=setup(t)
  add(db,1,'Nvidia CEO Jensen Huang resigns',{url:'https://microsoft.com/news'})
  add(db,2,'Nvidia CEO Jensen Huang resigns',{url:'https://forums.developer.nvidia.com/story'})
  add(db,3,'Nvidia CEO Jensen Huang resigns',{url:'https://two.example/story'})
  const e=eventRisk(db,{now:NOW}).events[0]
  assert.equal(e.confidence,'single');assert.equal(e.verification,'media_report');assert.equal(e.independentSources,1)
})
test('疑问假设与预期离任不当已发生事件；未采到的新闻不提前出现',t=>{
  const db=setup(t)
  add(db,1,'如果英伟达 CEO 黄仁勋辞职会怎样？')
  add(db,2,'Nvidia CEO will resign next year')
  add(db,3,'OpenAI CEO Sam Altman resigns')
  db.prepare('UPDATE raw_items SET fetched_at=? WHERE guid=?').run(new Date(NOW+3600000).toISOString(),'3')
  const r=eventRisk(db,{now:NOW});assert.equal(r.events.length,0);assert.equal(r.unconfirmed.length,1)
})
test('28天回查锚定旧报道，转载进入7天窗口不能把事件年龄重置',t=>{
  const db=setup(t)
  add(db,1,'Nvidia CEO Jensen Huang resigns',{hours:10*24})
  add(db,2,'Nvidia CEO Jensen Huang resigns',{hours:1})
  assert.equal(eventRisk(db,{now:NOW}).events[0].ageHours,240)
})
test('高管传闻不提高已直接报道的另一职位冲击强度',t=>{
  const db=setup(t)
  add(db,1,'Nvidia CFO resigns')
  const score=eventRisk(db,{now:NOW}).score
  add(db,2,'传闻英伟达 CEO 黄仁勋或将辞职')
  const r=eventRisk(db,{now:NOW});assert.equal(r.score,score);assert.equal(r.events[0].severity,62)
})

test('历史访谈、要求辞职、辞去别家公司董事职位不会误判为新的本公司离任',t=>{
  const db=setup(t)
  add(db,1,'The OpenAI board member who fired Sam Altman says we still cannot trust AI CEOs')
  add(db,2,'黄仁勋遭美国议员要求辞职，英伟达面临国会问询压力')
  add(db,3,'谷歌高管哈里森辞去 SpaceX 董事会职务，任职已超十年')
  const r=eventRisk(db,{now:NOW});assert.equal(r.events.length,0);assert.equal(r.unconfirmed.length,1)
})
test('前CEO离任与CFO接任标题属于同一离任线索，不会再制造CFO辞职事件',t=>{
  const db=setup(t)
  add(db,1,'英伟达宣布黄仁勋辞职，CFO科莱特·克雷斯出任临时CEO')
  add(db,2,'Nvidia CEO Jensen Huang resigns',{url:'https://two.example/story'})
  const r=eventRisk(db,{now:NOW});assert.equal(r.events.length,1);assert.equal(r.events[0].id,'NVDA:leadership:chief')
})
