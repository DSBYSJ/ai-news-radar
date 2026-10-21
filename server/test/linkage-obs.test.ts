import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  computeStats,
  recordObservations,
  settleObservations,
  writeSnapshot,
} from '../src/market/linkageObs.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

/** 10 个连续交易日 */
const DAYS = [
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14',
]

function addArticle(db: DatabaseSync, i: number, sourceId: string, date: string, entity: string): void {
  const rawId = Number(
    db.prepare(
      `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`,
    ).run(sourceId, `g${i}`, `https://x/${i}`, `https://x/${i}`, `t${i}`, `${date}T10:00:00Z`, `f${i}`, `${date}T10:00:00Z`).lastInsertRowid,
  )
  const artId = Number(
    db.prepare(
      `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at, ai_relevant)
       VALUES (?, ?, ?, NULL, '', 'other', NULL, 60, NULL, NULL, NULL, ?, ?, 1)`,
    ).run(rawId, `https://x/${i}`, `t${i}`, `${date}T10:00:00Z`, `${date}T10:00:00Z`).lastInsertRowid,
  )
  db.prepare('INSERT INTO mentions (article_id, entity) VALUES (?, ?)').run(artId, entity)
}

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','源1','u','rss',1)").run()
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s2','源2','u','rss',1)").run()
  const px = db.prepare('INSERT INTO equity_daily (symbol, date, close, volume) VALUES (?, ?, ?, 1000)')
  const idx = db.prepare('INSERT INTO macro_history (date, series, value) VALUES (?, ?, ?)')
  DAYS.forEach((d, i) => {
    px.run('NVDA', d, 100 + i)
    idx.run(d, 'nasdaq', 20000)
  })
  return db
}

/** 一个双源事件 */
function twoSourceEvent(db: DatabaseSync, date: string, entity = 'NVIDIA', base = 1): void {
  addArticle(db, base, 's1', date, entity)
  addArticle(db, base + 1, 's2', date, entity)
}

/* ============================================================
 * 验收 1：重复运行不重复记录
 * ============================================================ */
test('验收1：定时任务重复运行，不会重复记录同一事件', () => {
  const db = setup()
  twoSourceEvent(db, '2026-10-02')

  const a = recordObservations(db, { asOf: '2026-10-14', now: '2026-10-14T00:00:00Z' })
  assert.equal(a.inserted, 1)
  const b = recordObservations(db, { asOf: '2026-10-14', now: '2026-10-15T00:00:00Z' })
  assert.equal(b.inserted, 0, '第二次运行不应新增')
  assert.equal(b.existing, 1)

  const n = (db.prepare('SELECT COUNT(*) AS c FROM linkage_observations').get() as { c: number }).c
  assert.equal(n, 1, '表里只能有一条')
  db.close()
})

/* ============================================================
 * 验收 2：可追溯到首次发现时间、信源、映射版本
 * ============================================================ */
test('验收2：每个事件都记录了首次发现时间、信源数与映射版本', () => {
  const db = setup()
  twoSourceEvent(db, '2026-10-02')
  recordObservations(db, { asOf: '2026-10-14', now: '2026-10-14T00:00:00Z' })

  const row = db.prepare('SELECT * FROM linkage_observations').get() as Record<string, unknown>
  assert.equal(row.event_date, '2026-10-02')
  assert.equal(row.entity_raw, 'NVIDIA')
  assert.equal(row.entity_class, 'listed')
  assert.equal(row.symbol, 'NVDA')
  assert.equal(row.mapping_method, 'alias')
  assert.equal(Number(row.sources), 2, '首次入选时的信源数')
  assert.ok(row.mapping_version, '必须记录映射版本')
  assert.ok(row.algo_version, '必须记录算法版本')
  assert.ok(row.first_seen_at, '必须记录首次发现时间')
  db.close()
})

test('验收2b：映射规则变更后，历史记录不被改写', () => {
  const db = setup()
  twoSourceEvent(db, '2026-10-02', 'OpenAI')
  recordObservations(db, { asOf: '2026-10-14', now: '2026-10-14T00:00:00Z' })
  const before = db.prepare('SELECT entity_class, symbol, mapping_method FROM linkage_observations').get()

  // 假设后来补了别名（模拟映射规则变化）：再跑一次记录
  recordObservations(db, { asOf: '2026-10-14', now: '2026-10-20T00:00:00Z' })
  const after = db.prepare('SELECT entity_class, symbol, mapping_method FROM linkage_observations').get()
  assert.deepEqual(after, before, '首次记录的分类与映射必须原样保留')
  db.close()
})

/* ============================================================
 * 验收 3：T+5 只在 5 个交易日完整且价格有效后计算
 * ============================================================ */
test('验收3：T+5 未走完时保持 pending，走完后才 matured', () => {
  const db = setup()
  // 事件在倒数第 3 天（索引 7），后面只有 2 个交易日 → 不成熟
  twoSourceEvent(db, '2026-10-12')
  recordObservations(db, { asOf: '2026-10-14' })
  settleObservations(db, { asOf: '2026-10-14' })

  let row = db.prepare('SELECT status, t5_excess FROM linkage_observations').get() as {
    status: string
    t5_excess: number | null
  }
  assert.equal(row.status, 'pending', '窗口未走完必须 pending')
  assert.equal(row.t5_excess, null, '不能把未走完当成 0 收益')

  // 补足后续 5 个交易日
  const px = db.prepare('INSERT INTO equity_daily (symbol, date, close, volume) VALUES (?, ?, ?, 1000)')
  const idx = db.prepare('INSERT INTO macro_history (date, series, value) VALUES (?, ?, ?)')
  const more = ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21']
  more.forEach((d, i) => {
    px.run('NVDA', d, 200 + i)
    idx.run(d, 'nasdaq', 20000)
  })

  settleObservations(db, { asOf: '2026-10-21' })
  row = db.prepare('SELECT status, t5_excess FROM linkage_observations').get() as typeof row
  assert.equal(row.status, 'matured')
  assert.ok(row.t5_excess !== null, '走完后应算出 T+5')
  db.close()
})

/* ============================================================
 * 验收 4：未成熟 / 缺行情 / 无法映射 分别显示
 * ============================================================ */
test('验收4：三种未完成状态互不混淆', () => {
  const db = setup()
  twoSourceEvent(db, '2026-10-02', 'NVIDIA', 1) // 有价格、会成熟
  twoSourceEvent(db, '2026-10-13', 'NVIDIA', 3) // 有价格、未成熟
  twoSourceEvent(db, '2026-10-02', 'OpenAI', 5) // 未上市 → unmapped
  twoSourceEvent(db, '2026-10-02', 'Snowflake', 7) // 有别名但无行情 → no_price

  recordObservations(db, { asOf: '2026-10-14' })
  settleObservations(db, { asOf: '2026-10-14' })

  const rows = db.prepare('SELECT entity_raw, status, status_reason FROM linkage_observations').all() as {
    entity_raw: string
    status: string
    status_reason: string | null
  }[]
  const by = Object.fromEntries(rows.map((r) => [r.entity_raw, r]))

  assert.equal(by['NVIDIA'].status === 'matured' || by['NVIDIA'].status === 'pending', true)
  assert.equal(by['OpenAI'].status, 'unmapped')
  assert.match(by['OpenAI'].status_reason ?? '', /未上市/)
  assert.equal(by['Snowflake'].status, 'no_price', 'SNOW 有别名但没有行情')
  assert.match(by['Snowflake'].status_reason ?? '', /行情/)
  db.close()
})

test('验收4b：unknown 类的提示要说"识别能力不足"，不能说成"没有资产"', () => {
  const db = setup()
  twoSourceEvent(db, '2026-10-02', '某个没听过的主体')
  recordObservations(db, { asOf: '2026-10-14' })
  const row = db.prepare('SELECT entity_class, status_reason FROM linkage_observations').get() as {
    entity_class: string
    status_reason: string
  }
  assert.equal(row.entity_class, 'unknown')
  assert.match(row.status_reason, /识别能力不足/)
  db.close()
})

/* ============================================================
 * 验收 5：每日汇总可按历史截止日复现
 * ============================================================ */
test('验收5：同一 asOf 重算结果完全一致（可复现）', () => {
  const db = setup()
  twoSourceEvent(db, '2026-10-02')
  twoSourceEvent(db, '2026-10-13', 'NVIDIA', 3)
  recordObservations(db, { asOf: '2026-10-14' })
  settleObservations(db, { asOf: '2026-10-14' })

  const a = computeStats(db, { asOf: '2026-10-14' })
  const b = computeStats(db, { asOf: '2026-10-14' })
  assert.deepEqual(a, b, '同一天重算必须逐字段一致')

  // 用更早的截止日 → 只能看到当时的事件
  const early = computeStats(db, { asOf: '2026-10-05' })
  assert.ok(early.totalEvents < a.totalEvents, '早截止日应看不到后来的事件')
  assert.ok(early.priceDataUntil !== null && early.priceDataUntil <= '2026-10-05')
  db.close()
})

test('验收5b：快照记录算法版本/映射版本/价格截止日，可据以复现', () => {
  const db = setup()
  twoSourceEvent(db, '2026-10-02')
  recordObservations(db, { asOf: '2026-10-14' })
  settleObservations(db, { asOf: '2026-10-14' })
  const snap = writeSnapshot(db, { asOf: '2026-10-14' })

  assert.ok(snap.algoVersion)
  assert.ok(snap.mappingVersion)
  assert.equal(snap.priceDataUntil, '2026-10-14')
  assert.equal(snap.totalEvents, 1)
  db.close()
})

/* ============================================================
 * 验收 6：补录价格后能识别修订前后的差异
 * ============================================================ */
test('验收6：补录价格后结果变化 → revision 递增，原始记录不被抹掉', () => {
  const db = setup()
  // Snowflake 没有行情 → no_price
  twoSourceEvent(db, '2026-10-02', 'Snowflake')
  recordObservations(db, { asOf: '2026-10-14' })
  settleObservations(db, { asOf: '2026-10-14' })

  let row = db.prepare('SELECT status, revision, t5_excess FROM linkage_observations').get() as {
    status: string
    revision: number
    t5_excess: number | null
  }
  assert.equal(row.status, 'no_price')
  const revBefore = Number(row.revision)

  // 手工补录该标的的行情
  const px = db.prepare('INSERT INTO equity_daily (symbol, date, close, volume) VALUES (?, ?, ?, 1000)')
  DAYS.forEach((d, i) => px.run('SNOW', d, 50 + i))

  settleObservations(db, { asOf: '2026-10-14' })
  row = db.prepare('SELECT status, revision, t5_excess FROM linkage_observations').get() as typeof row
  assert.equal(row.status, 'matured', '补录后应能结算')
  assert.ok(Number(row.revision) > revBefore, 'revision 必须递增，才能区分修订前后')

  // 首次发现的事实（信源数、映射）不因重算而改变
  const first = db.prepare('SELECT sources, mapping_method, first_seen_at FROM linkage_observations').get() as Record<string, unknown>
  assert.equal(Number(first.sources), 2)
  assert.equal(first.mapping_method, 'alias')
  assert.ok(first.first_seen_at)
  db.close()
})

/* ------------------------------ 注册表（v0.44.0） ------------------------------ */

test('注册表：别名也能命中（不能只索引 key）', async () => {
  const { lookupRegistry } = await import('../src/market/entityRegistry.ts')
  assert.equal(lookupRegistry('Claude')?.symbol, null, 'Claude → 未上市（Anthropic）')
  assert.equal(lookupRegistry('Claude Code')?.key, 'claude', '别名必须能命中主条目')
  assert.equal(lookupRegistry('Muse Wonder Full')?.symbol, 'META')
  assert.equal(lookupRegistry('GPT-6-Astra')?.parentName, 'OpenAI')
  assert.equal(lookupRegistry('NVIDIA Corp'), null, '不做模糊包含')
})

test('classifyEntity：注册表优先于内置规则，且非企业实体不进"未映射"', async () => {
  const { classifyEntity } = await import('../src/market/entityClass.ts')
  const { symbolOfEntity } = await import('../src/market/universe.ts')

  const pytorch = classifyEntity('PyTorch', symbolOfEntity)
  assert.equal(pytorch.entityClass, 'noncorporate', '开源框架不是企业实体')
  assert.equal(pytorch.symbol, null)

  const torchtpu = classifyEntity('TorchTPU', symbolOfEntity)
  assert.equal(torchtpu.entityClass, 'product')
  assert.equal(torchtpu.symbol, 'GOOGL', 'TorchTPU 是 Google 开源项目')

  const apple = classifyEntity('Apple', symbolOfEntity)
  assert.equal(apple.entityClass, 'listed')
  assert.equal(apple.symbol, 'AAPL', '不在监测清单也要给出真实代码，状态会落到 no_price')
})

test('mappingFromRegistry：事件早于上市日 → 按未上市处理，不得映射', async () => {
  const { mappingFromRegistry } = await import('../src/market/entityClass.ts')
  const entry = {
    key: 'futureco',
    name: 'FutureCo',
    aliases: ['FutureCo'],
    entityClass: 'listed' as const,
    symbol: 'FCO',
    parentName: null,
    evidence: '测试用',
    confidence: 'confirmed' as const,
    listedSince: '2027-01-01',
  }

  const before = mappingFromRegistry(entry, '2026-06-01')
  assert.equal(before.entityClass, 'private', '上市前按未上市处理')
  assert.equal(before.symbol, null, '不能用后来的上市状态改写历史')
  assert.match(before.evidence ?? '', /2027-01-01 才上市/)

  const after = mappingFromRegistry(entry, '2027-03-01')
  assert.equal(after.entityClass, 'listed')
  assert.equal(after.symbol, 'FCO', '上市后才可映射')
})

test('mappingFromRegistry：unverified 一律留在 unknown，不硬猜', async () => {
  const { mappingFromRegistry } = await import('../src/market/entityClass.ts')
  const r = mappingFromRegistry({
    key: 'x',
    name: 'X',
    aliases: [],
    entityClass: 'listed',
    symbol: 'XXX',
    parentName: null,
    evidence: '证据不足',
    confidence: 'unverified',
  })
  assert.equal(r.entityClass, 'unknown')
  assert.equal(r.symbol, null)
})

/* -------------------- 映射质量：实体维度 vs 事件维度（v0.44.0） -------------------- */

test('映射质量：实体数 ≠ 事件数，且只读重放不改写冻结记录', async () => {
  const { coverageSummary } = await import('../src/market/linkageObs.ts')
  const db = setup()
  // 补 GOOGL 行情，用于判断"新映射的事件能否结算"
  const gx = db.prepare('INSERT INTO equity_daily (symbol, date, close, volume) VALUES (?, ?, ?, 1000)')
  DAYS.forEach((d, i) => gx.run('GOOGL', d, 200 + i))

  // 模拟"旧规则落库"的历史记录：当时认不出 Gemini（现规则可映射到 GOOGL）
  const ins = db.prepare(
    `INSERT INTO linkage_observations
       (event_id, event_date, entity_raw, entity_class, symbol, mapping_method, mapping_version,
        algo_version, first_seen_at, sources, mentions, status, revision, updated_at)
     VALUES (?, ?, 'Gemini', 'unknown', NULL, 'unresolved', 'alias-1', 'linkage-1', ?, 2, 3, 'unmapped', 0, ?)`,
  )
  ins.run('2026-10-02|Gemini', '2026-10-02', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')
  ins.run('2026-10-05|Gemini', '2026-10-05', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')

  const c = coverageSummary(db, { asOf: '2026-10-14' })
  assert.equal(c.entities, 1, '两条事件只对应 1 个实体')
  assert.equal(c.eventsBefore.unknown, 2, '当时两条都是 unknown')
  assert.equal(c.eventsAfter.product, 2, '按当前规则两条都归到 product')
  assert.equal(c.classified, 1)
  assert.equal(c.stillUnknown, 0)
  assert.equal(c.newlyMapped, 2)
  assert.equal(c.newlyEvaluable, 2, 'GOOGL 有行情 → 可结算')

  // 冻结记录必须原封不动
  const rows = db
    .prepare('SELECT entity_class, symbol, mapping_version FROM linkage_observations ORDER BY event_date')
    .all() as unknown as { entity_class: string; symbol: string | null; mapping_version: string }[]
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.equal(r.entity_class, 'unknown', '重放不得改写历史分类')
    assert.equal(r.symbol, null)
    assert.equal(r.mapping_version, 'alias-1', '重放不得改写历史映射版本')
  }
  db.close()
})

test('映射质量：无行情的实体仍算"可映射"，但不计入可结算', async () => {
  const { coverageSummary } = await import('../src/market/linkageObs.ts')
  const db = setup()
  // Apple 在注册表里是 listed（AAPL），但库里没有 AAPL 行情
  db.prepare(
    `INSERT INTO linkage_observations
       (event_id, event_date, entity_raw, entity_class, symbol, mapping_method, mapping_version,
        algo_version, first_seen_at, sources, mentions, status, revision, updated_at)
     VALUES ('2026-10-02|Apple', '2026-10-02', 'Apple', 'unknown', NULL, 'unresolved', 'alias-1',
             'linkage-1', '2026-10-02T00:00:00Z', 2, 2, 'unmapped', 0, '2026-10-02T00:00:00Z')`,
  ).run()

  const c = coverageSummary(db, { asOf: '2026-10-14' })
  assert.equal(c.newlyMapped, 1, '认得出 → 算可映射')
  assert.equal(c.newlyEvaluable, 0, '没行情 → 不能结算（分类完成 ≠ 结果可评估）')
  db.close()
})
