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

export const CATEGORY_COLORS: Record<string, string> = {
  model_release: '#dc2626',
  product_update: '#2563eb',
  research_paper: '#7c3aed',
  open_source: '#059669',
  funding: '#d97706',
  policy: '#0891b2',
  opinion: '#db2777',
  other: '#9ca3af',
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
