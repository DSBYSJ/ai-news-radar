/**
 * 划词高亮与批注（item 10）
 *
 * - 只存本地（localStorage），**不上传服务器、不公开**
 * - 结构：{ [文章/简报 key]: Highlight[] }
 * - 高亮渲染：把段落文本按高亮区间切段，包上 <mark>
 */

const KEY = 'sonar.highlights.v1'

export interface Highlight {
  id: string
  /** 高亮的原文（用于匹配与展示） */
  text: string
  /** 个人批注（可为空） */
  note: string
  /** 颜色（琥珀/青/灰） */
  color: 'amber' | 'teal' | 'slate'
  createdAt: string
}

type Store = Record<string, Highlight[]>

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Store
  } catch {
    return {}
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // 隐私模式/超额：静默失败，不影响阅读
  }
}

export function listHighlights(scope: string): Highlight[] {
  return load()[scope] ?? []
}

export function addHighlight(scope: string, text: string, note: string, color: Highlight['color'] = 'amber'): Highlight {
  const store = load()
  const item: Highlight = {
    id: `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text: text.trim(),
    note: note.trim(),
    color,
    createdAt: new Date().toISOString(),
  }
  store[scope] = [...(store[scope] ?? []), item]
  save(store)
  return item
}

export function removeHighlight(scope: string, id: string): void {
  const store = load()
  store[scope] = (store[scope] ?? []).filter((h) => h.id !== id)
  save(store)
}

const COLOR_CLASS: Record<Highlight['color'], string> = {
  amber: 'bg-amber-200/70 dark:bg-amber-400/25',
  teal: 'bg-teal-200/70 dark:bg-teal-400/25',
  slate: 'bg-slate-200/80 dark:bg-white/15',
}

/** 把一段文本按高亮区间切段渲染（命中部分包 <mark>） */
export function renderWithHighlights(text: string, highlights: Highlight[]): { text: string; hit: boolean }[] {
  if (highlights.length === 0) return [{ text, hit: false }]
  // 长的高亮优先匹配，避免短词覆盖长词
  const sorted = [...highlights].sort((a, b) => b.text.length - a.text.length)
  const ranges: { start: number; end: number; color: string }[] = []
  for (const h of sorted) {
    if (!h.text) continue
    let from = 0
    for (;;) {
      const idx = text.indexOf(h.text, from)
      if (idx < 0) break
      const start = idx
      const end = idx + h.text.length
      // 跳过与已有区间重叠的部分
      if (!ranges.some((r) => start < r.end && end > r.start)) {
        ranges.push({ start, end, color: COLOR_CLASS[h.color] })
      }
      from = idx + 1
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }]
  ranges.sort((a, b) => a.start - b.start)

  const out: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), hit: false })
    out.push({ text: text.slice(r.start, r.end), hit: true })
    cursor = r.end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out
}

export function highlightColorClass(color: Highlight['color']): string {
  return COLOR_CLASS[color]
}

/** 取当前选中的文本（去空白，最长 500 字） */
export function getSelectionText(): string {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return ''
  const text = sel.toString().replace(/\s+/g, ' ').trim()
  return text.length > 500 ? text.slice(0, 500) : text
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}
