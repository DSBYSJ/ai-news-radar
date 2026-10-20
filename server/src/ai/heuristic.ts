import type { Category } from './categories.ts'

/**
 * 启发式兜底分类器 —— 仅在 AI 不可用（无 Key / 调用失败）时使用。
 * 目的：宁可给个粗糙分类，也不要让管道断掉（分类缺失则趋势图无从计算）。
 * 结果会写入 score_parts.mode = 'heuristic'，后续 AI 恢复时可识别。
 */
const RULES: { category: Category; keywords: string[] }[] = [
  {
    category: 'research_paper',
    keywords: ['arxiv', 'paper', 'preprint', 'benchmark', 'sota', '论文', '研究', '学术'],
  },
  {
    category: 'open_source',
    keywords: ['open source', 'open-source', 'open weights', 'github.com', 'apache 2.0', 'mit license', '开源'],
  },
  {
    category: 'funding',
    keywords: ['raises', 'raised', 'funding', 'series a', 'series b', 'series c', 'valuation', 'ipo', '融资', '估值'],
  },
  {
    category: 'policy',
    keywords: ['regulat', 'policy', 'ai act', 'lawsuit', 'antitrust', 'ban', '监管', '政策', '法案', '合规', '诉讼'],
  },
  {
    category: 'model_release',
    keywords: ['gpt-', 'claude', 'gemini', 'llama', 'qwen', 'deepseek-v', 'mistral', 'releases', 'unveils', '模型发布', '大模型', '新模型'],
  },
  {
    category: 'opinion',
    keywords: ['opinion', 'interview', 'essay', 'commentary', '观点', '访谈', '评论', '专访'],
  },
  {
    category: 'product_update',
    keywords: ['launch', 'launches', 'launched', 'rolls out', 'now available', 'update', '上线', '更新', '新版', '版本'],
  },
]

export interface HeuristicResult {
  category: Category
  score: number
  reason: string
}

export function classifyByRules(title: string, summary: string): HeuristicResult {
  const text = `${title}\n${summary}`.toLowerCase()

  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (text.includes(kw)) {
        // 只给基础分；信源权重统一在 pipeline 里用 applySourceWeight 加减（避免两处口径不一致）
        const inTitle = title.toLowerCase().includes(kw)
        const score = Math.max(0, Math.min(100, (inTitle ? 55 : 45) + (rule.category === 'other' ? 0 : 5)))
        return { category: rule.category, score, reason: `启发式命中「${kw}」（${inTitle ? '标题' : '摘要'}）` }
      }
    }
  }

  return { category: 'other', score: 20, reason: '启发式未命中任何规则' }
}
