import type {
  CategoryRatioPoint,
  Edition,
  EntityItem,
  VelocityResponse,
} from '../types.ts'

/**
 * 导出工具（item 2）：日报 → Markdown（Obsidian/Notion 语法），图表 → CSV
 * 纯前端生成，不经过服务端；Chart 的 CSV 直接用图表背后的时间序列。
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 让浏览器有机会开始下载再回收
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 触发浏览器下载（统一入口，避免各处重复） */
export function downloadText(filename: string, content: string, mime: string): void {
  download(filename, content, mime)
}

// ---------- Markdown（Obsidian / Notion 友好） ----------

/** 把日报导出成 Markdown：标题层级 + 表格 + 图表引用占位符 */
export function editionToMarkdown(e: Edition): string {
  const lines: string[] = []
  lines.push(`# ${e.date} · AI 资讯日报`)
  lines.push('')
  if (e.headline?.title) {
    lines.push(`> **头条**：${e.headline.title}`)
    lines.push('')
  }
  lines.push(`- 导出于：${stamp(new Date())}`)
  lines.push(`- 条目总数：${e.stats.total}　·　跨源事件：${e.stats.crossSource}`)
  lines.push(`- 数据源：SONAR（跨源交叉 + 事件聚类 + 情感判定）`)
  lines.push('')

  if (e.brief?.content) {
    lines.push('## 综述')
    lines.push('')
    lines.push(e.brief.content)
    lines.push('')
  }

  for (const section of e.sections) {
    if (section.items.length === 0) continue
    lines.push(`## ${section.label ?? section.category}`)
    lines.push('')
    // 表格：Notion / Obsidian 都认识
    lines.push('| 标题 | 来源 | 分数 |')
    lines.push('| --- | --- | --- |')
    for (const item of section.items) {
      const title = item.title.replace(/\|/g, '\\|')
      const source = (item.sourceName ?? '').replace(/\|/g, '\\|')
      lines.push(`| [${title}](${item.url}) | ${source} | ${item.score ?? '—'} |`)
    }
    lines.push('')
  }

  if (e.flash.length > 0) {
    lines.push('## 快讯')
    lines.push('')
    for (const f of e.flash) {
      lines.push(`- ${f.title}${f.url ? `（[原文](${f.url})）` : ''}`)
    }
    lines.push('')
  }

  // 图表引用占位符：Obsidian 用 ![[...]]，Notion 用 ![](...)；两者都留一份说明
  lines.push('## 图表')
  lines.push('')
  lines.push('![[trend-volume-7d.png]]')
  lines.push('![[category-ratio-7d.png]]')
  lines.push('')
  lines.push('<!-- 将上面两行替换为实际图片附件：Obsidian 直接改名，Notion 改为 ![趋势](trend-volume-7d.png) -->')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('*由 SONAR 生成 · 内容来自各资讯源，版权归原作者*')
  return lines.join('\n')
}

export function exportEditionMarkdown(e: Edition): void {
  downloadText(`AI日报-${e.date}.md`, editionToMarkdown(e), 'text/markdown')
}

// ---------- CSV ----------

/** 通用二维表 → CSV（带 BOM，Excel 直接打开不乱码） */
export function tableToCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (v: string | number): string => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n')
  return `\uFEFF${body}`
}

export function exportVelocityCsv(v: VelocityResponse): void {
  const csv = tableToCsv(
    ['日期', '当日条数', '7 日均线'],
    v.points.map((p) => [p.date, p.count, p.ma7 ?? '']),
  )
  downloadText(`趋势-每日条数-${v.days}天.csv`, csv, 'text/csv')
}

export function exportCategoryCsv(points: CategoryRatioPoint[]): void {
  const cats = Object.keys(points[0]?.ratios ?? {})
  const csv = tableToCsv(
    ['日期', '总数', ...cats],
    points.map((p) => [p.date, p.total, ...cats.map((k) => p.ratios[k] ?? 0)]),
  )
  downloadText('趋势-分类占比.csv', csv, 'text/csv')
}

export function exportEntitiesCsv(items: EntityItem[], days: number): void {
  const csv = tableToCsv(
    ['实体', '提及次数'],
    items.map((e) => [e.entity, e.count]),
  )
  downloadText(`实体热度-${days}天.csv`, csv, 'text/csv')
}
