import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fnv1a64, hammingDistance, simhash64, simhashSimilarity, weightedTokens } from '../src/analytics/simhash.ts'

test('FNV-1a 64：确定性与区分度', () => {
  assert.equal(fnv1a64('hello'), fnv1a64('hello'))
  assert.notEqual(fnv1a64('hello'), fnv1a64('world'))
})

test('加权 token：标题权重高于摘要', () => {
  const weights = weightedTokens('OpenAI 发布', 'OpenAI 融资')
  // 标题出现一次 ×3，摘要出现一次 ×1 → 合计 4
  assert.equal(weights.get('openai'), 4)
})

test('SimHash：相同文本相似度为 1', () => {
  const a = simhash64('OpenAI 发布 GPT-6 面向所有用户开放', '新模型向全体用户开放')
  const b = simhash64('OpenAI 发布 GPT-6 面向所有用户开放', '新模型向全体用户开放')
  assert.equal(hammingDistance(a, b), 0)
  assert.equal(simhashSimilarity(a, b), 1)
})

test('SimHash：轻微改写仍 ≥ 0.75（聚类阈值口径）', () => {
  const a = simhash64('OpenAI 发布 GPT-6，面向所有用户开放', '新模型向全体用户开放，支持更长上下文')
  const b = simhash64('OpenAI 正式发布 GPT-6：面向所有用户开放', '新模型向全体用户开放，支持更长上下文')
  const sim = simhashSimilarity(a, b)
  assert.ok(sim >= 0.75, `改写文本相似度 ${sim} 应 ≥ 0.75`)
})

test('SimHash：不相关内容相似度低（< 0.75）', () => {
  const a = simhash64('OpenAI 发布 GPT-6，面向所有用户开放', '')
  const b = simhash64('特斯拉发布新款电池，续航里程大幅提升', '')
  const sim = simhashSimilarity(a, b)
  assert.ok(sim < 0.75, `不相关文本相似度 ${sim} 应 < 0.75`)
})

test('汉明距离：对称且非负', () => {
  const a = fnv1a64('text-a')
  const b = fnv1a64('text-b')
  assert.equal(hammingDistance(a, b), hammingDistance(b, a))
  assert.ok(hammingDistance(a, b) >= 0 && hammingDistance(a, b) <= 64)
})
