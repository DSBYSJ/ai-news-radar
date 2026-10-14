/**
 * 分类枚举 —— 必须锁死，绝不允许模型自由生成标签。
 * 原因：今天叫"模型发布"、明天叫"新模型上线"，趋势图就永远聚不起来。
 * 校验失败 → 重试 → 仍失败则兜底落 'other'，但不丢弃该条。
 */
export const CATEGORIES = [
  'model_release',
  'product_update',
  'research_paper',
  'open_source',
  'funding',
  'policy',
  'opinion',
  'other',
] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  model_release: '模型发布',
  product_update: '产品更新',
  research_paper: '研究论文',
  open_source: '开源项目',
  funding: '行业融资',
  policy: '政策监管',
  opinion: '观点访谈',
  other: '其他',
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}
