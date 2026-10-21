export interface SeedSource {
  id: string
  name: string
  url: string
  kind: 'rss' | 'api'
  weight: number
}

/**
 * 采集源清单（2026-10-21 服务器实测可达，见 docs/项目方案.md 第七节）
 *
 * ⚠️ 明确不接入（2026-10-21 在服务器上重测，结果如下）：
 *   返回 HTML 被拦（不绕，直接放弃）：36氪、品玩、机器之心、Stanford HAI、Cohere、LangChain
 *   格式无法解析（既非 RSS 也非 Atom）：虎嗅、VentureBeat AI、Hugging Face、Meta AI、
 *     The Batch、Import AI、Modal、Waymo、Anthropic、Google Developers、Fireworks、
 *     LMSYS、EleutherAI、IBM Research（这些站点在境内均取不到可用 feed，已试多个地址变体）
 *   源已停更：新浪科技（最新 2018-09）、SemiAnalysis（最新 2025-09）
 *   历史记录：Google DeepMind 本机不可达但**服务器可达**，已接入
 * ⚠️ 趋势分析要「宁可少而稳」：时通时不通的源会产生比源数量变化更难处理的噪声，
 *   不稳定的一律不接，哪怕内容很好。
 * ⚠️ 源要够多才看得出「跨源交叉度」——单一来源的独家报道天然没有交叉信号。
 * ⚠️ 只吃 RSS / 官方 API：不抓网页正文、不绕反爬。被拦的源一律放弃，不换 UA 硬试。
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
  // ---------- v0.30.0 新增 8 源（2026-10-21 服务器实测：200 + 当日有更新） ----------
  // 目的有两个：① 补「资本市场向」语料，让 NFI 的融资密度不再只有 3.2%；
  //            ② 补「官方一手 / 研究机构」，提升跨源交叉度的判定质量。
  {
    id: 'tmtpost',
    name: '钛媒体',
    url: 'https://www.tmtpost.com/rss.xml',
    kind: 'rss',
    weight: 2, // 18 条/轮，科技 + 一级市场，中文源里最贴近「融资叙事」
  },
  {
    id: 'jiemian',
    name: '界面新闻',
    url: 'https://a.jiemian.com/index.php?m=article&a=rss',
    kind: 'rss',
    weight: 1, // 30 条/轮，综合财经；AI 相关占比低，权重压低避免刷屏
  },
  {
    id: 'sspai',
    name: '少数派',
    url: 'https://sspai.com/feed',
    kind: 'rss',
    weight: 1, // 10 条/轮，偏消费与效率工具，AI 占比不高
  },
  {
    id: 'crunchbase-news',
    name: 'Crunchbase News',
    url: 'https://news.crunchbase.com/feed/',
    kind: 'rss',
    weight: 3, // 融资/并购一手数据源，直接补「估值叙事」缺口
  },
  {
    id: 'tc-venture',
    name: 'TechCrunch Venture',
    url: 'https://techcrunch.com/category/venture/feed/',
    kind: 'rss',
    weight: 2, // 一级市场动态，与 Crunchbase 形成交叉验证
  },
  {
    id: 'deepmind',
    name: 'Google DeepMind',
    url: 'https://deepmind.google/blog/rss.xml',
    kind: 'rss',
    weight: 3, // 官方一手；本机不可达但服务器可达（100 条/轮）
  },
  {
    id: 'ieee-ai',
    name: 'IEEE Spectrum AI',
    url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss',
    kind: 'rss',
    weight: 3, // 工程与研究向，噪声低
  },
  {
    id: 'wired-ai',
    name: 'Wired AI',
    url: 'https://www.wired.com/feed/tag/ai/latest/rss',
    kind: 'rss',
    weight: 2,
  },
  // ---------- v0.33.0 新增 6 个官方一手源 ----------
  // 线索来自 AIHOT 对照：它的 19 个来源里一半是官方工程博客，而我们一个都没有。
  // 2026-10-21 在服务器上逐个实测（HTTP 200 + 能解析 + 近期有更新）才接入。
  {
    id: 'vllm',
    name: 'vLLM Blog',
    url: 'https://vllm.ai/blog/rss.xml',
    kind: 'rss',
    weight: 3, // 推理框架一手发布，50 条/轮，当日有更新
  },
  {
    id: 'pytorch',
    name: 'PyTorch Blog',
    url: 'https://pytorch.org/blog/feed.xml',
    kind: 'rss',
    weight: 3, // 训练框架一手
  },
  {
    id: 'databricks',
    name: 'Databricks Blog',
    url: 'https://www.databricks.com/feed',
    kind: 'rss',
    weight: 2, // 企业级数据/模型平台，工程实践向
  },
  {
    id: 'metr',
    name: 'METR',
    url: 'https://metr.org/feed.xml',
    kind: 'rss',
    weight: 3, // AI 能力评估研究，噪声极低
  },
  {
    id: 'together',
    name: 'Together AI',
    url: 'https://www.together.ai/blog/rss.xml',
    kind: 'rss',
    weight: 2, // 推理云厂商，开源模型部署相关
  },
  {
    id: 'msr',
    name: 'Microsoft Research',
    url: 'https://www.microsoft.com/en-us/research/feed/',
    kind: 'rss',
    weight: 3, // 研究机构一手
  },
]
