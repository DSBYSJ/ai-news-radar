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

/**
 * 分类配色：中等饱和 + 高色相区分度（在莫兰迪基础上略提饱和——
 * 8 个分类堆叠时，过于"雾面"的颜色会糊成一片，看不出边界）。
 */
export const CATEGORY_COLORS: Record<string, string> = {
  model_release: '#cf5a5a', // 红
  product_update: '#5a8fd0', // 蓝
  research_paper: '#8f7ecd', // 紫
  open_source: '#57a97c', // 绿
  funding: '#d9a04a', // 橙黄
  policy: '#4fa8a8', // 青
  opinion: '#c473a5', // 粉
  other: '#9aa3ad', // 灰
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
