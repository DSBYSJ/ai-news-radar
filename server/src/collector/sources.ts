export interface SeedSource {
  id: string
  name: string
  url: string
  kind: 'rss' | 'api'
  weight: number
}

/**
 * 采集源清单（2026-10-14 服务器实测可达，见 docs/项目方案.md 第七节）
 *
 * ⚠️ 明确不接入（境内服务器实测不可达 / RSS 已停，改地址无效）：
 *   Google DeepMind、Hugging Face、Google Research、Mistral AI、BAIR（不可达）
 *   机器之心（RSS 已停，302 到 data-service）、Anthropic / Import AI / The Batch / Meta（无 RSS）
 * ⚠️ 趋势分析要「宁可少而稳」：时通时不通的源会产生比源数量变化更难处理的噪声，
 *   不稳定的一律不接，哪怕内容很好。
 * ⚠️ 源要够多才看得出「跨源交叉度」——单一来源的独家报道天然没有交叉信号。
 */
export const SEED_SOURCES: SeedSource[] = [
  {
    id: 'qbitai',
    name: '量子位',
    url: 'https://www.qbitai.com/feed',
    kind: 'rss',
    weight: 2,
  },
  {
    id: 'openai-news',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    kind: 'rss',
    weight: 3,
  },
  {
    id: 'techcrunch-ai',
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    kind: 'rss',
    weight: 2,
  },
  {
    id: 'arxiv-cs-ai',
    name: 'arXiv cs.AI',
    url: 'https://rss.arxiv.org/rss/cs.AI',
    kind: 'rss',
    weight: 2,
  },
  {
    id: 'hn-ai',
    name: 'Hacker News (AI)',
    url: 'https://hnrss.org/newest?q=AI',
    kind: 'rss',
    weight: 1,
  },
  {
    id: 'mit-tr-ai',
    name: 'MIT Tech Review AI',
    url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    kind: 'rss',
    weight: 3,
  },
  {
    id: 'the-verge-ai',
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    kind: 'rss',
    weight: 2,
  },
  {
    id: 'simon-willison',
    name: 'Simon Willison',
    url: 'https://simonwillison.net/atom/everything/',
    kind: 'rss',
    weight: 3,
  },
  {
    id: 'the-decoder',
    name: 'The Decoder',
    url: 'https://the-decoder.com/feed/',
    kind: 'rss',
    weight: 2,
  },
  {
    id: 'ars-technica-ai',
    name: 'Ars Technica AI',
    url: 'https://arstechnica.com/ai/feed/',
    kind: 'rss',
    weight: 2,
  },
  {
    id: 'nvidia-blog',
    name: 'NVIDIA Blog',
    url: 'https://blogs.nvidia.com/feed/',
    kind: 'rss',
    weight: 2,
  },
  {
    id: 'marktechpost',
    name: 'MarkTechPost',
    url: 'https://www.marktechpost.com/feed/',
    kind: 'rss',
    weight: 1,
  },
  {
    id: 'google-ai-blog',
    name: 'Google AI Blog',
    url: 'https://blog.google/technology/ai/rss/',
    kind: 'rss',
    weight: 2, // ⚠️ 需跟随重定向，fetch 已 redirect: 'follow'
  },
  // ---------- 中文源（v0.16.0，均在服务器实测可达；括号内为样本里 AI 相关占比） ----------
  {
    id: 'geekpark',
    name: '极客公园',
    url: 'https://www.geekpark.net/rss',
    kind: 'rss',
    weight: 2, // 24/30 条与 AI 相关，中文源里质量最高
  },
  {
    id: 'leiphone',
    name: '雷峰网',
    url: 'https://www.leiphone.com/feed',
    kind: 'rss',
    weight: 2, // 15/20
  },
  {
    id: 'infoq-cn',
    name: 'InfoQ 中文',
    url: 'https://www.infoq.cn/feed',
    kind: 'rss',
    weight: 2, // 12/20，偏工程与架构
  },
  {
    id: 'ifanr',
    name: '爱范儿',
    url: 'https://www.ifanr.com/feed',
    kind: 'rss',
    weight: 2, // 11/20，消费科技 + AI
  },
  {
    id: 'ithome',
    name: 'IT之家',
    url: 'https://www.ithome.com/rss/',
    kind: 'rss',
    weight: 2, // 32/60，量大速度快（AIHOT 也用它）
  },
]
