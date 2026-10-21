import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeCrs,
  computeNfi,
  detectDivergences,
  fomoCoefficient,
  logisticScore,
  percentileRank,
  stepResponse,
  zScore,
  DEFAULT_PARAMS,
  type MacroSeriesInput,
} from '../src/risk/calculation.ts'

/* ------------------------------ 统计工具 ------------------------------ */

test('percentileRank：值在历史中的位置正确', () => {
  const history = Array.from({ length: 100 }, (_, i) => i) // 0..99
  assert.equal(percentileRank(50, history), 0.505)
  assert.equal(percentileRank(0, history), 0.005)
  assert.equal(percentileRank(99, history), 0.995)
  assert.equal(percentileRank(50, [1, 2, 3]), null, '样本不足返回 null')
})

test('zScore：相对均值与标准差', () => {
  const history = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  assert.equal(zScore(1, history), null, '标准差为 0 时返回 null')
  const h = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const z = zScore(15, h)
  assert.ok(z !== null && z > 2, `z 应明显大于 2，实际 ${z}`)
})

test('stepResponse：阈值以下是 0，超过后非线性跳升并封顶 100', () => {
  assert.equal(stepResponse(4.0, 4.5, 2.2), 0)
  const just = stepResponse(4.6, 4.5, 2.2)
  const far = stepResponse(6.0, 4.5, 2.2)
  assert.ok(just > 0 && just < 30, `刚过阈值应较小，实际 ${just}`)
  assert.ok(far > just, '越超阈值风险越高')
  assert.ok(far <= 100)
  assert.equal(stepResponse(99, 4.5, 2.2), 100, '封顶 100')
})

test('logisticScore：z 越高分越高', () => {
  assert.ok(logisticScore(0, 1, 1) < logisticScore(2, 1, 1))
})

/* ------------------------------ FOMO ------------------------------ */

test('fomoCoefficient：追高词与感叹号都能拉高系数', () => {
  const hot = fomoCoefficient(['暴涨翻倍！踏空狂飙！史诗级！'])
  const cold = fomoCoefficient(['公司发布新模型，接口更新。'])
  assert.ok(hot.score > cold.score, `FOMO 应区分：hot=${hot.score} cold=${cold.score}`)
  assert.ok(hot.hits.length >= 3, `应命中多个追高词：${hot.hits.join(',')}`)
  assert.ok(hot.exclaimDensity > 0)
})

/* ------------------------------ NFI v2 ------------------------------ */

test('computeNfi：分项缺失时按剩余权重归一，不补 0', () => {
  const full = computeNfi(
    {
      moneyShare: 0.08,
      sentimentSkew: 0.3,
      concentration: 0.2,
      acceleration: 1.2,
      fomo: { score: 40, hits: [], exclaimDensity: 0 },
    },
    DEFAULT_PARAMS,
  )
  const partial = computeNfi(
    {
      moneyShare: 0.08,
      sentimentSkew: null, // 样本不足
      concentration: null,
      acceleration: null,
      fomo: { score: 40, hits: [], exclaimDensity: 0 },
    },
    DEFAULT_PARAMS,
  )
  assert.ok(full.score !== null && partial.score !== null)
  // 缺失项不参与：只剩 money 与 fomo 两项（权重 22 + 20）
  const moneyScore = full.factors.find((f) => f.key === 'money')!.score as number
  const fomoScore = full.factors.find((f) => f.key === 'fomo')!.score as number
  const expect = Math.round((moneyScore * 22 + fomoScore * 20) / 42)
  assert.equal(partial.score, expect, '应按剩余权重归一')
})

test('computeNfi：加速度超过阈值后按阶跃跳升', () => {
  const base = computeNfi(
    { moneyShare: 0.05, sentimentSkew: 0.2, concentration: 0.1, acceleration: 1.2, fomo: { score: 10, hits: [], exclaimDensity: 0 } },
    DEFAULT_PARAMS,
  )
  const jumped = computeNfi(
    { moneyShare: 0.05, sentimentSkew: 0.2, concentration: 0.1, acceleration: 2.0, fomo: { score: 10, hits: [], exclaimDensity: 0 } },
    DEFAULT_PARAMS,
  )
  assert.ok(jumped.score! > base.score! + 3, `阶跃应明显抬高：${base.score} → ${jumped.score}`)
})

/* ------------------------------ CRS v2 ------------------------------ */

function macro(key: string, value: number, history: number[], extra: Partial<MacroSeriesInput> = {}): MacroSeriesInput {
  return { key, label: key, value, history, yearAgo: history[0] ?? null, avg200: null, high52w: null, ...extra }
}

test('computeCrs：瀑布图各项贡献之和 == 合计（核心不变量）', () => {
  const r = computeCrs(
    {
      nfi: 40,
      rates: macro('rates', 5.2, Array.from({ length: 300 }, (_, i) => 3 + (i % 100) / 50)),
      credit: macro('credit', 4.8, Array.from({ length: 300 }, (_, i) => 2.5 + (i % 100) / 60)),
      index: macro('index', 24000, Array.from({ length: 300 }, (_, i) => 20000 + i), { avg200: 22000, high52w: 28000 }),
      inversion: false,
    },
    DEFAULT_PARAMS,
  )
  const items = r.waterfall.filter((w) => w.kind === 'item')
  const sum = items.reduce((s, w) => s + w.value, 0)
  assert.ok(Math.abs(sum - r.score) <= 1, `瀑布图求和 ${sum} 应等于总分 ${r.score}`)
  assert.equal(r.waterfall[r.waterfall.length - 1].value, r.score, '合计行应等于总分')
})

test('computeCrs：OAS 处于危机水平（即使一年没变）也要给高信用分（修复旧 bug）', () => {
  const r = computeCrs(
    {
      nfi: 30,
      rates: macro('rates', 4.5, Array.from({ length: 300 }, (_, i) => 3 + (i % 100) / 50)),
      // OAS 常年 5.5%，一年没变 → 旧算法只给 5 分
      credit: macro('credit', 5.5, Array.from({ length: 300 }, () => 5.5)),
      index: macro('index', 20000, Array.from({ length: 300 }, (_, i) => 19000 + i)),
      inversion: false,
    },
    DEFAULT_PARAMS,
  )
  const credit = r.factors.find((f) => f.key === 'credit')!
  assert.ok(credit.score >= 60, `危机级 OAS 应给高分，实际 ${credit.score}`)
})

test('computeCrs：指数大幅回撤也要给高分（修复旧 bug）', () => {
  const r = computeCrs(
    {
      nfi: 30,
      rates: macro('rates', 4.0, Array.from({ length: 300 }, (_, i) => 3 + (i % 100) / 50)),
      credit: macro('credit', 3.0, Array.from({ length: 300 }, (_, i) => 3 + (i % 20) / 100)),
      // 现价 20000，52 周高点 30000 → 回撤 33%
      index: macro('index', 20000, Array.from({ length: 300 }, (_, i) => 19000 + i), { avg200: 21000, high52w: 30000 }),
      inversion: false,
    },
    DEFAULT_PARAMS,
  )
  const index = r.factors.find((f) => f.key === 'index')!
  assert.ok(index.score >= 60, `深回撤应给高分，实际 ${index.score}`)
})

test('computeCrs：回撤触发动态权重（宏观项权重放大）', () => {
  const mk = (high52w: number) =>
    computeCrs(
      {
        nfi: 40,
        rates: macro('rates', 4.8, Array.from({ length: 300 }, (_, i) => 3 + (i % 100) / 50)),
        credit: macro('credit', 3.2, Array.from({ length: 300 }, (_, i) => 3 + (i % 20) / 100)),
        index: macro('index', 20000, Array.from({ length: 300 }, (_, i) => 19000 + i), { avg200: 21000, high52w }),
        inversion: false,
      },
      DEFAULT_PARAMS,
    )
  const normal = mk(20500) // 几乎没回撤
  const crashed = mk(30000) // 回撤 33%
  assert.equal(normal.dynamicTriggered?.drawdown, false)
  assert.equal(crashed.dynamicTriggered?.drawdown, true)
  const nfiWeightNormal = normal.factors.find((f) => f.key === 'narrative')!.weight
  const nfiWeightCrash = crashed.factors.find((f) => f.key === 'narrative')!.weight
  assert.ok(nfiWeightCrash < nfiWeightNormal, '回撤时叙事权重应被稀释')
})

test('computeCrs：高利率+宽利差（系统性危机）要高于 高利率+紧利差（虚假繁荣）', () => {
  const common = { nfi: 30, rates: macro('rates', 5.3, Array.from({ length: 300 }, (_, i) => 3 + (i % 100) / 50)), index: macro('index', 20000, Array.from({ length: 300 }, (_, i) => 19000 + i)), inversion: false }
  const crisis = computeCrs({ ...common, credit: macro('credit', 6.0, Array.from({ length: 300 }, () => 6)) }, DEFAULT_PARAMS)
  const boom = computeCrs({ ...common, credit: macro('credit', 2.4, Array.from({ length: 300 }, () => 2.4)) }, DEFAULT_PARAMS)
  assert.ok(crisis.score > boom.score, `系统性危机(${crisis.score}) 应高于虚假繁荣(${boom.score})`)
})

/* ------------------------------ 背离检测 ------------------------------ */

test('detectDivergences：情绪极乐观 + 指数连跌 3 天 → 触发情绪×价格背离', () => {
  const out = detectDivergences({
    optimism: 85,
    indexDownDays: 3,
    heatSurgeRatio: 1.1,
    fundingChangeRatio: 0.1,
    entity: null,
    moneyShare: 0.05,
    indexChange: -0.04,
    params: DEFAULT_PARAMS,
  })
  const hit = out.find((d) => d.type === 'sentiment_price')
  assert.ok(hit, '应触发情绪×价格背离')
  assert.equal(hit!.severity, 'warning')
  assert.equal(out.find((d) => d.type === 'narrative_macro'), undefined, '融资叙事占比 5% 不该触发叙事×宏观')
})

test('detectDivergences：热度激增但融资骤降 → 触发热度×融资背离', () => {
  const out = detectDivergences({
    optimism: 50,
    indexDownDays: 0,
    heatSurgeRatio: 3.0,
    fundingChangeRatio: -0.6,
    entity: '某公司',
    moneyShare: 0.05,
    indexChange: 0.01,
    params: DEFAULT_PARAMS,
  })
  const hit = out.find((d) => d.type === 'heat_funding')
  assert.ok(hit, '应触发热度×融资背离')
  assert.equal(hit!.entity, '某公司')
})

test('detectDivergences：条件不满足时不误报', () => {
  const out = detectDivergences({
    optimism: 60,
    indexDownDays: 1,
    heatSurgeRatio: 1.2,
    fundingChangeRatio: 0.05,
    entity: null,
    moneyShare: 0.03,
    indexChange: 0.01,
    params: DEFAULT_PARAMS,
  })
  assert.equal(out.length, 0, `不应触发任何背离，实际 ${JSON.stringify(out)}`)
})

/* ------------------------------ 窗口边界回归 ------------------------------ */

test('narrativeInputs：必须按 now 截断窗口（不能把"到今天"的条目算进历史日期）', async () => {
  const { readFileSync } = await import('node:fs')
  const { DatabaseSync } = await import('node:sqlite')
  const { narrativeInputs } = await import('../src/risk/narrative.ts')

  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'))
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','源','u','rss',2)").run()

  const addAt = (id: number, at: string, title: string): void => {
    const rawId = Number(
      db
        .prepare(
          `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
           VALUES ('s1', ?, ?, ?, ?, '', ?, ?, ?)`,
        )
        .run(`g${id}`, `https://x/${id}`, `https://x/${id}`, title, at, `f${id}`, at).lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at, ai_relevant)
       VALUES (?, ?, ?, NULL, '', 'other', NULL, 60, NULL, 'positive', NULL, ?, ?, 1)`,
    ).run(rawId, `https://x/${id}`, title, at, at)
  }
  // 4 月 1 条、10 月 5 条
  addAt(1, '2026-04-10T10:00:00Z', '四月的新闻')
  for (let i = 2; i <= 6; i++) addAt(i, `2026-10-${10 + i}T10:00:00Z`, `十月的新闻 ${i}`)

  // 以 4 月底为"今天"：窗口内只有 4 月那条
  const april = narrativeInputs(db, { days: 30, now: Date.parse('2026-04-30T12:00:00Z') })
  assert.equal(april.articles, 1, `4 月底的 30 天窗口只能看到 1 条，实际 ${april.articles}`)

  // 以 10 月底为"今天"：能看到 10 月的 5 条（4 月的超出窗口）
  const oct = narrativeInputs(db, { days: 30, now: Date.parse('2026-10-31T12:00:00Z') })
  assert.equal(oct.articles, 5, `10 月底的 30 天窗口只能看到 5 条，实际 ${oct.articles}`)
  db.close()
})

test('computeNfi：窗口内条目太少时返回 null 而不是 0（"没数据"≠"冷静"）', () => {
  const r = computeNfi(
    {
      articles: 5,
      moneyShare: 0,
      sentimentSkew: null,
      concentration: null,
      acceleration: null,
      fomo: { score: 0, hits: [], exclaimDensity: 0 },
    },
    DEFAULT_PARAMS,
  )
  assert.equal(r.score, null, '5 条样本应返回 null')
  assert.equal(r.band, 'unknown')

  const enough = computeNfi(
    {
      articles: 50,
      moneyShare: 0,
      sentimentSkew: null,
      concentration: null,
      acceleration: null,
      fomo: { score: 0, hits: [], exclaimDensity: 0 },
    },
    DEFAULT_PARAMS,
  )
  assert.equal(enough.score, 0, '样本够时才返回实测值')
})
