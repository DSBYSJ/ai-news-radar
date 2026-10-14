import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { askQuestion, classifyQuestion, cosine, ensureVectors, extractCitations, extractDate, hashVector, retrieve } from '../src/ai/ask.ts'
import { extractSql, formatRowsAsAnswer, numbersIn, stripNarrative, validateSql } from '../src/ai/sql.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.exec("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','量子位','u','rss',2),('s2','TechCrunch AI','u','rss',2)")

  const add = (guid: string, sourceId: string, title: string, summary: string, day = 0) => {
    const at = new Date(Date.now() - day * 86_400_000).toISOString()
    const rawId = Number(
      db
        .prepare(
          `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(sourceId, guid, `https://x/${guid}`, `https://x/${guid}`, title, summary, at, `fp-${guid}`, at).lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at)
       VALUES (?,?,?,NULL,?,?,NULL,70,NULL,NULL,NULL,?,?)`,
    ).run(rawId, `https://x/${guid}`, title, summary, 'model_release', at, at)
  }

  add('a1', 's1', '英伟达发布新一代 AI 芯片，算力提升三倍', 'AI 芯片新品发布，制程与算力全面提升')
  add('a2', 's2', 'OpenAI 发布 GPT-6 模型', '新模型在多项基准上大幅提升')
  add('a3', 's1', '某公司宣布裁员 500 人', '公司裁减员工，负面消息')
  return db
}

test('问题路由：统计类 vs 归因类', () => {
  assert.equal(classifyQuestion('本周 Agent 类文章有几篇？'), 'stats')
  assert.equal(classifyQuestion('为什么 10-13 号 AI 芯片热度飙升？'), 'attribution')
  assert.equal(classifyQuestion('开源项目占比最高的是哪类'), 'stats')
})

test('日期抽取：三种写法都能识别', () => {
  assert.equal(extractDate('2026-10-13 的情况'), '2026-10-13')
  assert.equal(extractDate('10-13 号'), `${new Date().getUTCFullYear()}-10-13`)
  assert.equal(extractDate('10月13日'), `${new Date().getUTCFullYear()}-10-13`)
  assert.equal(extractDate('没有日期'), null)
})

test('SQL 校验：只读 / 白名单 / 单语句 / 强制 LIMIT', () => {
  assert.equal(validateSql('SELECT COUNT(*) AS n FROM articles').ok, true)
  assert.match(validateSql('SELECT COUNT(*) AS n FROM articles').sql, /LIMIT 50$/)
  assert.equal(validateSql('SELECT a.id FROM articles a LIMIT 10').sql.includes('LIMIT 10'), true)

  assert.equal(validateSql('DROP TABLE articles').ok, false)
  assert.equal(validateSql('DELETE FROM articles').ok, false)
  assert.equal(validateSql('UPDATE articles SET score = 0').ok, false)
  assert.equal(validateSql('PRAGMA table_info(articles)').ok, false)
  assert.equal(validateSql('ATTACH DATABASE \'x\' AS y').ok, false)
  assert.equal(validateSql('SELECT 1; DROP TABLE articles').ok, false)
  assert.equal(validateSql('SELECT * FROM sqlite_master').ok, false, 'sqlite_master 不在白名单')
  // CTE 名字放行
  assert.equal(validateSql('WITH recent AS (SELECT id FROM articles LIMIT 5) SELECT COUNT(*) FROM recent').ok, true)
})

test('extractSql：剥离围栏与结尾分号', () => {
  assert.equal(extractSql('```sql\nSELECT 1;\n```'), 'SELECT 1')
  assert.equal(extractSql('SELECT 2;'), 'SELECT 2')
  assert.equal(extractSql('-- 注释\nSELECT 3'), 'SELECT 3')
})

test('数字闸门：解读里出现结果中没有的数字 → 整段丢弃', () => {
  const rows = [{ 篇数: 12 }]
  assert.equal(numbersIn('大约 12 篇，确实不少').includes('12'), true)
  assert.equal(stripNarrative('大约 12 篇，确实不少', rows), '大约 12 篇，确实不少')
  assert.equal(stripNarrative('大约 99 篇', rows), null)
  assert.equal(stripNarrative('最近这一周抓取量整体平稳', rows), '最近这一周抓取量整体平稳')
})

test('结果格式化：单值 / 多行 / 空结果', () => {
  assert.match(formatRowsAsAnswer([{ 篇数: 12 }], '本周几篇'), /\*\*12\*\*/)
  assert.match(formatRowsAsAnswer([], '不存在的问题'), /没有符合/)
  const multi = formatRowsAsAnswer([{ c: 'a', n: 1 }, { c: 'b', n: 2 }], '分类分布')
  assert.match(multi, /查到 \*\*2\*\* 行/)
  assert.match(multi, /\| c \| n \|/)
})

test('向量：同文本相似度≈1，无关文本低；中文查询能命中相关文章', () => {
  const a = hashVector('英伟达发布新一代 AI 芯片')
  assert.ok(cosine(a, hashVector('英伟达发布新一代 AI 芯片')) > 0.99)
  assert.ok(cosine(a, hashVector('公司宣布裁员五百人')) < 0.5)

  const db = setup()
  const stat = ensureVectors(db)
  assert.equal(stat.total, 3)
  assert.equal(stat.built, 3)
  // 幂等：内容没变不再重算
  assert.equal(ensureVectors(db).built, 0)

  const hits = retrieve(db, 'AI 芯片', 2)
  assert.ok(hits.length >= 2)
  assert.ok(hits[0].title.includes('芯片'), `首位应为芯片相关，实际：${hits[0].title}`)
  assert.equal(hits[0].index, 1)
  assert.ok(hits[0].url.startsWith('https://'))
  db.close()
})

test('引用抽取：只认检索结果里的编号', () => {
  const sources = [
    { index: 1, title: '英伟达发布新一代 AI 芯片', url: 'https://x/1', sourceName: '量子位', date: '2026-10-13', snippet: '芯片新品', similarity: 0.5 },
    { index: 2, title: 'OpenAI 发布 GPT-6 模型', url: 'https://x/2', sourceName: 'TechCrunch AI', date: '2026-10-13', snippet: '新模型', similarity: 0.3 },
  ]
  assert.deepEqual(extractCitations('结论是需求上涨 [1]，另一面是 [2]。', sources), [1, 2])
  assert.deepEqual(extractCitations('没有引用编号的纯文本', sources), [])
  assert.deepEqual(extractCitations('越界引用 [9]', sources), [], '越界编号应忽略')
})

test('检索：问题带日期时，候选收窄到该日期窗口内', () => {
  const db = setup()
  // 造一条 30 天前的"芯片"文章：若不按日期收窄，它会挤进结果
  const at = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES ('s1','old-chip',?,?,?,'老文章',?,'fp-old',?)`,
      )
      .run('https://x/old-chip', 'https://x/old-chip', '老一代 AI 芯片发布', at, at).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at)
     VALUES (?,?,?,NULL,'老文章','model_release',NULL,70,NULL,NULL,NULL,?,?)`,
  ).run(rawId, 'https://x/old-chip', '老一代 AI 芯片发布', at, at)

  const today = new Date().toISOString().slice(0, 10)
  const wide = retrieve(db, 'AI 芯片', 5)
  const narrow = retrieve(db, 'AI 芯片', 5, { date: today, windowDays: 3 })

  assert.ok(wide.some((h) => h.date !== today), '宽检索应能捞到 30 天前那篇')
  assert.ok(
    narrow.every((h) => h.date === today),
    '按日期收窄后只应返回当天条目',
  )
  db.close()
})

test('askQuestion：AI 未配置时不编造，安全降级', async () => {
  const db = setup()
  const stats = await askQuestion('本周 Agent 类文章有几篇？', { db, useAi: false })
  assert.equal(stats.kind, 'stats')
  assert.equal(stats.mode, 'fallback')
  assert.match(stats.answer, /AI 未配置/)

  const attribution = await askQuestion('为什么 10-13 号 AI 芯片热度飙升？', { db, useAi: false })
  assert.equal(attribution.kind, 'attribution')
  assert.equal(attribution.sources.length, 3)
  assert.ok(attribution.sources[0].title.includes('芯片'))
  assert.ok(attribution.sources[0].url.startsWith('https://'))
  db.close()
})