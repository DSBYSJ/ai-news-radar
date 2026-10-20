import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeRelevance } from '../src/ai/relevance.ts'

test('judgeRelevance：纯消费电子不算 AI（手机/折叠屏）', () => {
  const r = judgeRelevance(
    '1 分钟售罄、发货排到明年，iPhone Duo 卖爆背后的真相',
    '苹果首款折叠屏 iPhone Duo 开启预售，开售 1 分钟全型号库存就空了，京东、天猫页面相继显示售罄。',
  )
  assert.equal(r.relevant, false, `不应判为 AI，命中：${r.hits.join(',')}`)
})

test('judgeRelevance：AI 硬件与算力算 AI（用户明确要看的）', () => {
  assert.equal(judgeRelevance('英伟达 RTX PRO 5500 为何遭到提前疯抢').relevant, true)
  assert.equal(judgeRelevance('国产 GPU 厂商发布新一代推理卡').relevant, true)
  assert.equal(judgeRelevance('某云厂商加码智算中心，算力规模翻倍').relevant, true)
  assert.equal(judgeRelevance('HBM 供应紧张，AI 服务器成本上涨').relevant, true)
})

test('judgeRelevance：AI 概念/产品算 AI', () => {
  assert.equal(judgeRelevance('DeepSeek 开源新模型').relevant, true)
  assert.equal(judgeRelevance('Claude 推出 Dashboards 与 Motion').relevant, true)
  assert.equal(judgeRelevance('一文看懂多模态与提示词工程').relevant, true)
})

test('judgeRelevance：英文按词边界匹配，"said" 不会命中 ai', () => {
  const r = judgeRelevance('Analysts said the market is waiting for a chain reaction')
  assert.equal(r.relevant, false, `误命中：${r.hits.join(',')}`)
})

test('judgeRelevance：摘要里只出现一次强信号不算（避免蹭词）', () => {
  const r = judgeRelevance('新款轻薄本发布，售价 4999 元起', '可选配大模型加速模块，另有多种颜色。')
  assert.equal(r.relevant, false, '仅摘要里一次提及不足以判为 AI 资讯')
})
