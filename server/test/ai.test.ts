import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CATEGORIES, isCategory } from '../src/ai/categories.ts'
import { normalizeEntity } from '../src/ai/entities.ts'
import { classifyByRules } from '../src/ai/heuristic.ts'
import { extractJson, parseStage1, parseStage2 } from '../src/ai/parse.ts'
import { buildStage1Prompt } from '../src/ai/prompts.ts'

test('isCategory：只接受固定枚举', () => {
  assert.equal(isCategory('model_release'), true)
  assert.equal(isCategory('模型发布'), false)
  assert.equal(isCategory(undefined), false)
})

test('buildStage1Prompt：枚举齐全且包含条目', () => {
  const prompt = buildStage1Prompt([{ id: 1, title: '标题甲', summary: '摘要乙', source: '某源' }])
  for (const c of CATEGORIES) assert.ok(prompt.includes(c), `缺少枚举 ${c}`)
  assert.ok(prompt.includes('标题甲'))
})

test('extractJson：容忍代码围栏与前后多余文字', () => {
  assert.deepEqual(extractJson('```json\n[1,2]\n```'), [1, 2])
  assert.deepEqual(extractJson('好的：\n{"a":1}\n以上'), { a: 1 })
  assert.equal(extractJson('完全没有 json'), null)
})

test('parseStage1：非法分类兜底 other、分数夹取到 0~100、未知 id 丢弃', () => {
  const raw = '[{"id":1,"category":"乱写","score":999},{"id":2,"category":"funding","score":-5},{"id":99,"category":"policy","score":50}]'
  const out = parseStage1(raw, [1, 2])
  assert.ok(out)
  assert.equal(out.length, 2)
  assert.equal(out[0].category, 'other')
  assert.equal(out[0].score, 100)
  assert.equal(out[1].category, 'funding')
  assert.equal(out[1].score, 0)
})

test('parseStage1：兼容对象包一层（JSON 模式下常见）', () => {
  const raw = '{"results":[{"id":1,"category":"funding","score":70}]}'
  const out = parseStage1(raw, [1])
  assert.ok(out)
  assert.equal(out[0].category, 'funding')
  assert.equal(out[0].score, 70)
})

test('parseStage1：完全无法解析时返回 null（交给调用方兜底）', () => {
  assert.equal(parseStage1('抱歉，我无法完成', [1]), null)
})

test('parseStage2：实体去空并保留顺序', () => {
  const out = parseStage2('{"tldr":"一句话","summary":"两句","entities":["OpenAI","  ","GPT-5"]}')
  assert.ok(out)
  assert.equal(out.tldr, '一句话')
  assert.deepEqual(out.entities, ['OpenAI', 'GPT-5'])
})

test('启发式兜底：关键词命中对应枚举（AI 不可用时的保险）', () => {
  assert.equal(classifyByRules('Startup raises $100M Series B', '').category, 'funding')
  assert.equal(classifyByRules('New paper on arXiv about agents', '').category, 'research_paper')
  assert.equal(classifyByRules('某团队开源了模型权重', '').category, 'open_source')
  assert.equal(classifyByRules('今天天气不错', '').category, 'other')
})

test('实体规范化：别名归一、泛称剔除', () => {
  assert.equal(normalizeEntity('openai'), 'OpenAI')
  assert.equal(normalizeEntity('OpenAI Inc.'), 'OpenAI')
  assert.equal(normalizeEntity('huggingface'), 'Hugging Face')
  assert.equal(normalizeEntity('AI'), null)
  assert.equal(normalizeEntity('大模型'), null)
})
