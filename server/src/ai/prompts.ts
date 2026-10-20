import { CATEGORIES } from './categories.ts'

export interface Stage1Input {
  id: number
  title: string
  summary: string
  source: string
}

function truncate(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 阶段 1：批量分类 + 打分（轻量、便宜）；输入截断至 300 字 */
export function buildStage1Prompt(items: Stage1Input[]): string {
  // ⚠️ 显示的编号即输出里的 id（用真实数据库 id 会让模型照抄长数字且容易串行）
  const list = items
    .map((it, i) => `${i + 1}. [标题] ${truncate(it.title, 160)}\n   [来源] ${it.source}\n   [摘要] ${truncate(it.summary, 300)}`)
    .join('\n')

  return `你在为 AI 资讯做分类与重要性评估。

【分类枚举】（只能选其中之一，不得自创）
${CATEGORIES.join(' | ')}

【相关性】ai 为 true/false：这条是否与 AI 有关。
  true  ：AI 模型/算法/产品/服务，AI 芯片与算力（GPU/显卡/HBM/数据中心/智算），AI 公司的重要动作
  false ：纯消费电子（手机/耳机/相机/平板/家电）、纯汽车/游戏/影视、与 AI 无关的资本八卦、纯营销稿
  注意：手机发布会如果只是硬件参数 → false；如果重点是端侧 AI 能力/模型 → true。
  英伟达/AMD 等 GPU 与算力消息 → true。

【打分标准】score 为 0~100 整数，评估"一个忙碌的 AI 工程师错过它会不会后悔"：
  90-100  范式级事件（重大模型发布、行业级政策落地）
  70-89   重要更新（主流工具大版本、知名机构重要论文）
  40-69   值得知道（常规发布、常规论文）
  0-39    噪音（营销稿、重复转载、边缘消息）

【输入条目】
${list}

【输出】只输出 JSON 对象，不要任何解释或 Markdown 代码块，格式严格为：
{"results":[{"id":1,"category":"model_release","score":92,"ai":true,"reason":"..."}, ...]}
说明：id 就是上面条目的编号（1、2、3…），必须覆盖全部 ${items.length} 条；
category 只能取上面枚举里的值；score 是 0~100 的整数；ai 必须是布尔值，不要漏。`
}

export interface Stage2Input {
  title: string
  source: string
  content: string
}

/** 阶段 2：仅对高分条目做深度加工 */
export function buildStage2Prompt(input: Stage2Input): string {
  return `为下面这条 AI 资讯生成中文提炼。

【要求】
1. tldr：一句话概括，不超过 30 字，说清"谁做了什么"。
2. summary：2~3 句话，保留关键数据（金额、百分比、版本号），
   不要写"据悉""值得注意的是"这类空话。
3. entities：抽取其中的公司、模型、产品名，用【最通用的写法】，
   不要带版本后缀（写 "GPT-5" 而不是 "GPT-5 Turbo Preview"）。
   只抽真正的主语与宾语，不要抽泛称（如"AI""大模型"）。

【输入】
标题：${truncate(input.title, 200)}
来源：${input.source}
内容：${truncate(input.content, 1200)}

【输出】只输出 JSON，不要解释：
{"tldr":"...","summary":"...","entities":["...","..."]}`
}
