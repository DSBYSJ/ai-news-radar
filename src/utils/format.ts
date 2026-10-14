export const CATEGORY_LABELS: Record<string, string> = {
  model_release: '模型发布',
  product_update: '产品更新',
  research_paper: '研究论文',
  open_source: '开源项目',
  funding: '行业融资',
  policy: '政策监管',
  opinion: '观点访谈',
  other: '其他',
}

/** 低饱和「莫兰迪」色系：不刺眼、深浅两套主题下都耐看 */
export const CATEGORY_COLORS: Record<string, string> = {
  model_release: '#b1776f', // 陶土红
  product_update: '#7f9bb3', // 雾蓝
  research_paper: '#9a8fb5', // 灰紫
  open_source: '#7fa98f', // 鼠尾草绿
  funding: '#c9a06a', // 驼色
  policy: '#7fa7a8', // 灰青
  opinion: '#b98fa8', // 藕粉
  other: '#a3a8b0', // 灰
}

export const CATEGORY_ORDER = [
  'model_release',
  'product_update',
  'research_paper',
  'open_source',
  'funding',
  'policy',
  'opinion',
  'other',
]

/** 库里存 UTC，展示层转本地 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 只取 MM-DD（图表 X 轴用） */
export function shortDate(date: string): string {
  return date.length >= 10 ? date.slice(5) : date
}

export function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function scoreColor(score: number | null): string {
  if (score === null) return '#9ca3af'
  if (score >= 70) return '#dc2626'
  if (score >= 40) return '#d97706'
  return '#9ca3af'
}
