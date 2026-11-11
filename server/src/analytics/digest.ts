/**
 * 汇总帖识别（早报 / 晚报 / 周报 / 晨报 / 一周回顾…）
 *
 * 为什么要单独识别：
 *   "早报"类文章不是一件事，而是一本合订本（一篇塞 20 条新闻、30+ 实体）。
 *   让它进热度榜会有两个坏结果：
 *     ① 热度必然第一 —— 它天然"多来源 + 多篇报道"（其实是多家早报被聚到一起）；
 *     ② 污染聚类 —— 它是实体中转站，会把不相关的新闻串成一个巨簇。
 *   所以：**汇总帖不进热度榜 / 不当头条**，但仍保留在资讯列表里（读起来是有用的）。
 *
 * 判定以标题的结构性特征为主，避免误伤正文里出现"简报/汇总"的普通新闻：
 *   ✅ "Edge AI Daily 早报（11月11日）"、"IT早报 1111：…"、"派早报：…"、"【钛晨报】…"
 *   ❌ "Reddit 将推出 AI 汇总商品评价系统"（汇总只是词，不是合订本）
 *   ❌ "黄仁勋爆出来的不是出轨，是一年前那份被压下的简报"
 */

/** 位于标题开头才算"合订本栏目名" */
const PREFIX_RE =
  /^\s*[【\[（(]?\s*(派早报|IT早报|爱范早报|早报|晚报|日报|周报|旬报|晨报|钛晨报|每日速览|每日要闻|一周要闻|本周要闻|科技早报|AI\s*早报)/i

/** 带日期括号的早报（"…早报（11月11日）"） */
const DATE_DIGEST_RE = /(早报|晚报|日报|周报|晨报)\s*[（(]\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*[）)]/

/** 一周回顾类 */
const WEEKLY_RE = /(一周|本周|上周)\s*(回顾|要闻|速递|简报|精选|热点|盘点)/

/** 多个栏目标签的合订本（"…早报 1111："） */
const NUMBERED_RE = /(早报|晚报|日报|周报|晨报)\s*[0-9０-９]{3,4}\s*[：:|｜]/

export function isDigestTitle(title: string): boolean {
  if (!title) return false
  const t = title.trim()
  if (PREFIX_RE.test(t)) return true
  if (DATE_DIGEST_RE.test(t)) return true
  if (WEEKLY_RE.test(t)) return true
  if (NUMBERED_RE.test(t)) return true
  return false
}

/*
 * 备注：**不要**用"实体数 > 6"单独判定汇总帖 ——
 * 大型合作/发布会也会提到 7–8 个主体（OpenAI + 微软 + NVIDIA + Azure…），会被误伤。
 * 实体数只作为聚类的**保护条件**（见 events.ts 的 MAX_ENTITIES_FOR_MERGE），不做展示过滤。
 */
