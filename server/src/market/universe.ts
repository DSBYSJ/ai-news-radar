/**
 * 美股 AI 产业链监测清单（v0.36.0）
 *
 * 为什么是"清单"而不是"全市场"：
 *   1. 免费额度按请求数计（FMP 250/天、AV 25/天），全市场跑不动
 *   2. 全市场会把"AI 泡沫"稀释成"美股整体"，失去本项目的问题意识
 *   3. 固定清单才能做历史分位 —— 每次换成分股，分位就不成立了
 *
 * 分层逻辑（按"离 AI 资本开支的距离"）：
 *   chip  算力芯片与存储   —— 最直接受益，也是最先被质疑"透支"的一层
 *   infra 服务器/网络/电源  —— 资本开支落地的地方
 *   cloud 云与平台          —— 花钱的一方，看利润率能否撑住
 *   app   模型与应用        —— 收入兑现最慢，估值弹性最大
 *
 * ⚠️ 清单一旦确定就不要随意增删：增删会改变"板块整体估值"的口径，
 *    历史分位会失真。要改就整段重算（sync 会覆盖同日数据）。
 */

export type Segment = 'chip' | 'infra' | 'cloud' | 'app'

export const SEGMENT_LABELS: Record<Segment, string> = {
  chip: '算力芯片',
  infra: '服务器与网络',
  cloud: '云与平台',
  app: '模型与应用',
}

export interface Company {
  symbol: string
  name: string
  segment: Segment
  /** 一句话说明它在这条链上的位置（界面上直接显示，避免只看到代码） */
  role: string
  /**
   * 新闻实体别名（用于把 mentions.entity 映射到股票代码）。
   * 中英文都要有：中文源写「英伟达」，英文源写 "NVIDIA"。
   */
  aliases: string[]
}

export const UNIVERSE: Company[] = [
  // 算力芯片与存储
  { symbol: 'NVDA', name: 'NVIDIA', segment: 'chip', role: 'GPU 训练/推理主力，AI 资本开支的第一收款方' , aliases: ['NVIDIA', '英伟达', 'Nvidia'] },
  { symbol: 'AMD', name: 'AMD', segment: 'chip', role: 'GPU 第二供应商，MI 系列' , aliases: ['AMD', '超威半导体'] },
  { symbol: 'AVGO', name: 'Broadcom', segment: 'chip', role: '定制 ASIC 与网络芯片' , aliases: ['Broadcom', '博通'] },
  { symbol: 'MU', name: 'Micron', segment: 'chip', role: 'HBM 高带宽显存，算力的隐性瓶颈' , aliases: ['Micron', '美光'] },
  { symbol: 'MRVL', name: 'Marvell', segment: 'chip', role: '数据中心互联与定制芯片' , aliases: ['Marvell'] },
  { symbol: 'TSM', name: '台积电(ADR)', segment: 'chip', role: '先进制程代工，全链路的物理上限' , aliases: ['TSMC', '台积电'] },
  // 服务器与网络
  { symbol: 'SMCI', name: 'Super Micro', segment: 'infra', role: 'AI 服务器整机' , aliases: ['Super Micro', 'Supermicro', '超微电脑'] },
  { symbol: 'DELL', name: 'Dell', segment: 'infra', role: '企业级 AI 服务器与存储' , aliases: ['Dell', '戴尔'] },
  { symbol: 'ANET', name: 'Arista', segment: 'infra', role: '数据中心以太网交换' , aliases: ['Arista'] },
  { symbol: 'VRT', name: 'Vertiv', segment: 'infra', role: '数据中心供电与液冷' , aliases: ['Vertiv'] },
  // 云与平台
  { symbol: 'MSFT', name: 'Microsoft', segment: 'cloud', role: 'Azure + OpenAI 最大金主' , aliases: ['Microsoft', '微软'] },
  { symbol: 'GOOGL', name: 'Alphabet', segment: 'cloud', role: 'TPU 自研 + Gemini' , aliases: ['Google', '谷歌', 'Alphabet', 'DeepMind'] },
  { symbol: 'AMZN', name: 'Amazon', segment: 'cloud', role: 'AWS + 自研 Trainium' , aliases: ['Amazon', '亚马逊', 'AWS'] },
  { symbol: 'ORCL', name: 'Oracle', segment: 'cloud', role: 'OCI 算力租赁，AI 订单弹性大' , aliases: ['Oracle', '甲骨文'] },
  { symbol: 'META', name: 'Meta', segment: 'cloud', role: '自建算力，开源模型路线' , aliases: ['Meta', 'Facebook'] },
  // 模型与应用
  { symbol: 'PLTR', name: 'Palantir', segment: 'app', role: '企业侧 AI 落地，收入兑现较快' , aliases: ['Palantir'] },
  { symbol: 'SNOW', name: 'Snowflake', segment: 'app', role: '数据层，AI 应用的地基' , aliases: ['Snowflake'] },
  { symbol: 'CRWD', name: 'CrowdStrike', segment: 'app', role: '安全侧 AI 应用' , aliases: ['CrowdStrike'] },
]

export function companyOf(symbol: string): Company | undefined {
  return UNIVERSE.find((c) => c.symbol === symbol)
}

/** 实体名 → 股票代码（大小写不敏感，按别名精确匹配，避免 "Meta" 命中 "Metadata"） */
export function symbolOfEntity(entity: string): string | null {
  const e = entity.trim().toLowerCase()
  if (!e) return null
  for (const c of UNIVERSE) {
    if (c.symbol.toLowerCase() === e) return c.symbol
    if (c.aliases.some((a) => a.toLowerCase() === e)) return c.symbol
  }
  return null
}
