import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CATEGORY_MAP, compareBenchmark, compareKey, spearman, type OurRow } from '../src/aihot/benchmark.ts'
import type { AihotItem } from '../src/aihot/client.ts'

/**
 * AIHOT 对照的纯逻辑测试。
 * 不联网 —— 网络部分（ETag/限流/429）交给线上跑，这里只钉住容易静默出错的匹配逻辑。
 */

function item(url: string, opts: Partial<AihotItem> = {}): AihotItem {
  return {
    id: url,
    title: '标题',
    originalTitle: null,
    summary: null,
    source: '某源',
    url,
    permalink: 'https://aihot.news/items/x',
    publishedAt: '2026-10-21T00:00:00Z',
    category: 'industry',
    score: 80,
    selected: true,
    reason: null,
    ...opts,
  }
}

function ours(url: string, opts: Partial<OurRow> = {}): OurRow {
  return {
    url,
    title: '标题',
    score: 60,
    category: 'funding',
    published_at: '2026-10-21T00:00:00Z',
    source_name: '某源',
    ...opts,
  }
}

test('compareKey：抹掉协议、www、末尾斜杠与追踪参数', () => {
  const a = compareKey('https://www.example.com/a/b/?utm_source=x')
  const b = compareKey('http://example.com/a/b')
  assert.equal(a, b, `归一化后应一致：${a} vs ${b}`)
})

test('compareKey：不同路径不能误判为同一条', () => {
  assert.notEqual(compareKey('https://example.com/a'), compareKey('https://example.com/b'))
})

test('compareBenchmark：按 URL 对齐，分别统计重合/漏选/多选', () => {
  const aihot = [item('https://www.example.com/a?utm_source=x'), item('https://example.com/b')]
  const ourRows = [ours('http://example.com/a'), ours('https://example.com/c', { score: 70 }), ours('https://example.com/d', { score: 10 })]

  const r = compareBenchmark(aihot, ourRows, 45)
  assert.equal(r.matched.length, 1, 'a 应被匹配（归一化后相同）')
  assert.equal(r.onlyAihot.length, 1, 'b 我们没收')
  assert.equal(r.onlyOurs.length, 1, 'c 我们选了但它没收；d 分数低不算精选')
})

test('compareBenchmark：分类按口径映射后比较，other 不参与', () => {
  const aihot = [item('https://e.com/1', { category: 'industry' }), item('https://e.com/2', { category: 'paper' })]
  const ourRows = [ours('https://e.com/1', { category: 'funding' }), ours('https://e.com/2', { category: 'other' })]
  const r = compareBenchmark(aihot, ourRows, 45)
  assert.equal(r.matched.length, 2)
  // funding→industry 一致；other 无映射，不参与一致率
  assert.equal(r.categoryAgreement, 1)
})

test('compareBenchmark：样本不足时相关性与一致率返回 null，不硬编 0', () => {
  const r = compareBenchmark([item('https://e.com/x')], [ours('https://e.com/x')], 45)
  assert.equal(r.scoreRankCorrelation, null, '1 个点算不出相关')
  assert.ok(r.categoryAgreement !== null)
})

test('spearman：完全正相关 = 1，完全负相关 = -1，并列处理不崩', () => {
  assert.ok(Math.abs((spearman([1, 2, 3], [10, 20, 30]) as number) - 1) < 1e-9)
  assert.ok(Math.abs((spearman([1, 2, 3], [30, 20, 10]) as number) + 1) < 1e-9)
  assert.equal(spearman([1, 1], [2, 2]), null, '样本 < 3 返回 null')
  const ties = spearman([1, 2, 2, 3], [1, 2, 3, 4])
  assert.ok(ties !== null && ties > 0.8 && ties <= 1)
})

test('CATEGORY_MAP：我们的 8 类里只有 other 没有对应口径', () => {
  const unmapped = Object.keys(CATEGORY_MAP).includes('other')
  assert.equal(unmapped, false, 'other 不应有映射（否则会把"未分类"算成一致）')
  for (const v of Object.values(CATEGORY_MAP)) {
    assert.ok(['ai-models', 'ai-products', 'industry', 'paper', 'tip', 'opinion'].includes(v), `非法目标分类：${v}`)
  }
})
