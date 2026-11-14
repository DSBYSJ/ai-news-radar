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

test('多源直接报道提高证据权重；大量无关新闻不稀释重大事件', (t) => {
  const db = setup(t)
  add(db, 1, '黄仁勋辞去英伟达 CEO 职务', { url: 'https://one.example/story' })
  const one = eventRisk(db, { now: NOW })
  add(db, 2, 'Nvidia CEO Jensen Huang resigns', { url: 'https://two.example/story' })
  const two = eventRisk(db, { now: NOW })
  assert.ok(two.score! > one.score!)
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
