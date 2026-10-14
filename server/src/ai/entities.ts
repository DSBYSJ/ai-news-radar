/**
 * 实体规范化 —— "OpenAI" / "openai" / "OpenAI Inc." 必须算作同一个实体，
 * 否则趋势统计会被拆成好几份。做法：先按别名字典归一，再交给 mentions 表。
 */
const ALIASES: Record<string, string> = {
  openai: 'OpenAI',
  'openai inc': 'OpenAI',
  'openai inc.': 'OpenAI',
  anthropic: 'Anthropic',
  'anthropic pbc': 'Anthropic',
  google: 'Google',
  deepmind: 'Google DeepMind',
  'google deepmind': 'Google DeepMind',
  meta: 'Meta',
  facebook: 'Meta',
  'meta platforms': 'Meta',
  microsoft: 'Microsoft',
  nvidia: 'NVIDIA',
  'nvidia corporation': 'NVIDIA',
  huggingface: 'Hugging Face',
  'hugging face': 'Hugging Face',
  deepseek: 'DeepSeek',
  'deepseek-ai': 'DeepSeek',
  mistral: 'Mistral AI',
  'mistral ai': 'Mistral AI',
  xai: 'xAI',
  apple: 'Apple',
  amazon: 'Amazon',
  aws: 'AWS',
  tesla: 'Tesla',
  alibaba: '阿里巴巴',
  qwen: '通义千问',
  baidu: '百度',
  bytedance: '字节跳动',
  moonshot: '月之暗面',
  zhipu: '智谱',
  huawei: '华为',
  tsmc: '台积电',
}

/** 泛称不入实体（提示词已要求不抽，这里是第二道保险） */
const GENERIC = new Set([
  'ai',
  'a.i.',
  'agi',
  'llm',
  'llms',
  '大模型',
  '人工智能',
  '模型',
  '研究',
  '团队',
  '公司',
  '开发者',
  'researchers',
  'researcher',
])

export function normalizeEntity(raw: string): string | null {
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/gu, '')
    .replace(/[^\p{L}\p{N})%.]+$/gu, '')
    .trim()

  if (text.length < 2 || text.length > 60) return null
  if (GENERIC.has(text.toLowerCase())) return null

  return ALIASES[text.toLowerCase()] ?? text
}
