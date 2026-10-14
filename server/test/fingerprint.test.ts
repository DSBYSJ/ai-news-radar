import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeUrl, titleFingerprint } from '../src/collector/fingerprint.ts'

test('normalizeUrl：剥离 utm_* 与 fbclid 追踪参数', () => {
  assert.equal(
    normalizeUrl('https://example.com/post?a=1&utm_source=x&utm_medium=y&fbclid=z'),
    'https://example.com/post?a=1',
  )
})

test('normalizeUrl：去掉 fragment', () => {
  assert.equal(normalizeUrl('https://example.com/post#section-2'), 'https://example.com/post')
})

test('normalizeUrl：非法 URL 原样返回（trim 后）', () => {
  assert.equal(normalizeUrl('  not-a-url  '), 'not-a-url')
})

test('titleFingerprint：大小写 / 标点 / 全角 / 噪声词不敏感', () => {
  assert.equal(titleFingerprint('OpenAI 发布 GPT-5！'), titleFingerprint('openai 发布 gpt-5'))
})

test('titleFingerprint：不同标题指纹不同', () => {
  assert.notEqual(titleFingerprint('OpenAI 发布 GPT-5'), titleFingerprint('Anthropic 融资 20 亿'))
})
