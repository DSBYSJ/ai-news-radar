/**
 * AI 相关性判定（v0.19.0）
 *
 * 为什么要有：源是全站科技媒体（IT之家、爱范儿…），会带进来大量手机/家电/汽车新闻。
 * 只看"是不是科技"不够 —— 用户要的是 **AI 及其硬件（GPU/算力/芯片）**。
 *
 * 判定策略：
 * 1. 模型在阶段 1 里顺带给一个 `ai` 布尔（有就用模型的，语义判断比关键词准）
 * 2. 模型没给（降级为启发式）时，用关键词兜底：
 *    命中「强信号」即可；只有「弱信号」（芯片/服务器/算法这类泛词）不算。
 * 3. 纯消费电子（手机/耳机/相机/家电）即便有"芯片"，只要没有 AI 强信号 → 判为非 AI。
 *
 * 关键词写法上区分中英文：英文必须按词边界匹配，否则 `ai` 会命中 `said`/`wait`/`chain`。
 */

/** 强信号：命中即认为是 AI 相关内容（含 AI 硬件与算力） */
const STRONG_KEYWORDS = [
  // 通用 AI 概念
  'ai', '人工智能', '大模型', '语言模型', '机器学习', '深度学习', '神经网络', '生成式', 'aigc',
  'llm', 'gpt', 'chatgpt', 'openai', 'claude', 'gemini', 'deepseek', 'qwen', 'llama', 'mistral',
  '通义', '文心', '豆包', 'kimi', '混元', '星火', '智谱', 'glm', 'minimax', '月之暗面', '零一万物',
  '智能体', 'agent', '多模态', '提示词', 'prompt', '微调', 'fine-tun', '预训练', '后训练',
  'transformer', 'rag', 'embedding', '向量检索', '推理模型', '思维链', 'diffusion', '扩散模型',
  '具身智能', '人形机器人', '自动驾驶', '智驾', '数字人', '语音合成', '文生图', '文生视频', 'sora',
  'robot', 'robotics', 'chatbot', 'copilot', 'inference', 'fine-tuning', 'open-weight',
  'siri', 'alexa', 'apple intelligence', '语音助手', '智能音箱', '智能助手', '端侧', 'on-device', '大语言模型',
  // AI 硬件 / 算力（用户明确关心）
  'gpu', '显卡', '算力', '数据中心', '智算', 'ai芯片', 'ai 芯片', 'hbm', 'cuda', 'tpu', 'npu',
  '英伟达', 'nvidia', 'amd', '寒武纪', '昇腾', '壁仞', '摩尔线程', '海光', '光模块', '液冷', '超算',
]

/** 弱信号：泛科技词，单独出现不足以判为 AI（避免"搭载芯片的手机"混进来） */
const WEAK_KEYWORDS = ['芯片', '服务器', '算法', '模型', '云计算', '机器人', '自动化']

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 英文按词边界匹配；中文按子串 */
function hit(text: string, keyword: string): boolean {
  if (/^[a-z0-9 .+-]+$/.test(keyword)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRe(keyword)}([^a-z0-9]|$)`, 'i').test(text)
  }
  return text.includes(keyword)
}

export interface RelevanceResult {
  relevant: boolean
  /** 命中的强信号关键词（title 命中的排前面） */
  hits: string[]
  /** 仅命中弱信号时为 true，便于排查"为什么没收录" */
  weakOnly: boolean
}

/** 关键词兜底判定（不联网、零成本） */
export function judgeRelevance(title: string, summary = ''): RelevanceResult {
  const t = title.toLowerCase()
  const s = summary.toLowerCase()
  const hits: string[] = []

  for (const kw of STRONG_KEYWORDS) {
    if (hit(t, kw)) {
      hits.push(kw)
    } else if (hit(s, kw)) {
      hits.push(`${kw}(摘要)`)
    }
  }

  const titleHit = hits.some((h) => !h.endsWith('(摘要)'))
  const summaryHits = hits.filter((h) => h.endsWith('(摘要)')).length
  const weakOnly = hits.length === 0 && WEAK_KEYWORDS.some((kw) => hit(t, kw) || hit(s, kw))

  return {
    relevant: titleHit || summaryHits >= 2,
    hits: hits.slice(0, 5),
    weakOnly,
  }
}
