/**
 * 实体分类（v0.43.0）
 *
 * 为什么要分类：之前把"映射不到股票"一律当成"没有可投资资产"，
 * 这是错的 —— 至少混了三种完全不同的情况：
 *
 *   1. **listed**     直接就是上市公司（NVIDIA → NVDA）→ 可直接联动
 *   2. **product**    是产品/品牌，但属于某上市母公司（Gemini → GOOGL）
 *                     → 可间接联动，但"Gemini 的新闻"不等于"Google 的新闻"
 *   3. **private**    确实是未上市主体（OpenAI / Anthropic / DeepSeek）→ 真的无法联动
 *   4. **unknown**    别名表没覆盖到 → 这是**我们识别能力不足**，不是"没有资产"
 *
 * 分开统计才能区分"叙事真的与证券脱节"和"我们没认出来"。
 */

export type EntityClass = 'listed' | 'product' | 'private' | 'unknown'

export const ENTITY_CLASS_LABELS: Record<EntityClass, string> = {
  listed: '直接上市公司',
  product: '产品/品牌（关联母公司）',
  private: '未上市主体',
  unknown: '暂无法确定',
}

/** 产品/品牌 → 上市母公司（母公司须在本项目 UNIVERSE 里） */
const PRODUCT_PARENT: Record<string, string> = {
  gemini: 'GOOGL',
  'google cloud': 'GOOGL',
  android: 'GOOGL',
  deepmind: 'GOOGL',
  copilot: 'MSFT',
  'azure openai': 'MSFT',
  windows: 'MSFT',
  llama: 'META',
  'meta ai': 'META',
  'aws bedrock': 'AMZN',
  bedrock: 'AMZN',
  'trainium': 'AMZN',
  'nvidia h100': 'NVDA',
  h100: 'NVDA',
  blackwell: 'NVDA',
  'cuda': 'NVDA',
  'mi300': 'AMD',
  'mi325': 'AMD',
  'foundry': 'TSM',
}

/**
 * 已知未上市主体。
 * 这份清单会过时（公司会 IPO），所以只作为**分类线索**，
 * 不作为"永远无法映射"的判断依据。
 */
const PRIVATE_COMPANIES = new Set([
  'openai',
  'anthropic',
  'deepseek',
  'mistral',
  'mistral ai',
  'xai',
  'perplexity',
  'ssi',
  'safe superintelligence',
  'minimax',
  'moonshot',
  'moonshot ai',
  '月之暗面',
  '智谱',
  'zhipu',
  '百川智能',
  '阶跃星辰',
  '零一万物',
  'cohere',
  'together ai',
  'hugging face',
  'midjourney',
  'runway',
  'suno',
  'eleutherai',
  'stability ai',
])

export interface EntityMapping {
  entityClass: EntityClass
  /** 可联动的股票代码（product 类填母公司） */
  symbol: string | null
  /** 映射方式，写进观察记录便于追溯 */
  method: 'direct' | 'alias' | 'product-parent' | 'private' | 'unresolved'
  /** product 类的母公司名（仅展示用） */
  parent: string | null
}

export function classifyEntity(entity: string, resolveListed: (e: string) => string | null): EntityMapping {
  const e = entity.trim().toLowerCase()
  if (!e) return { entityClass: 'unknown', symbol: null, method: 'unresolved', parent: null }

  // 1) 直接是上市公司（ticker 本身或别名）
  const listed = resolveListed(entity)
  if (listed) {
    return {
      entityClass: 'listed',
      symbol: listed,
      method: entity.trim().toUpperCase() === listed ? 'direct' : 'alias',
      parent: null,
    }
  }

  // 2) 产品/品牌 → 母公司
  const parent = PRODUCT_PARENT[e]
  if (parent) {
    return { entityClass: 'product', symbol: parent, method: 'product-parent', parent }
  }

  // 3) 已知未上市
  if (PRIVATE_COMPANIES.has(e)) {
    return { entityClass: 'private', symbol: null, method: 'private', parent: null }
  }

  // 4) 认不出来 —— 这是识别能力问题，不是"没有资产"
  return { entityClass: 'unknown', symbol: null, method: 'unresolved', parent: null }
}
