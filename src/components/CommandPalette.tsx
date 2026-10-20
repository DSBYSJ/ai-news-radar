import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.ts'
import type { Article, EntityItem, SummaryListItem } from '../types.ts'

/**
 * 全局快捷检索（Ctrl+K / Cmd+K）
 *
 * - 跨三类内容统一检索：[文章] [实体] [简报]，结果带分类标签与上下文摘要
 * - 键盘：↑↓ 移动 / Enter 跳转 / Esc 关闭
 * - 250ms 防抖：避免每敲一个字符都发请求
 * - 数据源全部复用现有接口，没有新增后端依赖
 */

type Hit =
  | { kind: 'article'; id: number; title: string; context: string; url: string; date: string }
  | { kind: 'entity'; name: string; title: string; context: string; count: number }
  | { kind: 'summary'; date: string; title: string; context: string }

const KIND_LABEL: Record<Hit['kind'], string> = { article: '文章', entity: '实体', summary: '简报' }

const KIND_STYLE: Record<Hit['kind'], string> = {
  article: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300',
  entity: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  summary: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
}

interface Props {
  open: boolean
  onClose: () => void
  /** 跳转：文章 → 资讯页；实体 → 趋势页；简报 → 简报页 */
  onNavigate: (tab: 'list' | 'trend' | 'summary', payload?: string) => void
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export default function CommandPalette({ open, onClose, onNavigate }: Props) {
  const [raw, setRaw] = useState('')
  const q = useDebounced(raw.trim(), 250)
  const [hits, setHits] = useState<Hit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    if (open) {
      setRaw('')
      setHits([])
      setActive(0)
      // 自动聚焦：打开就能直接打字
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open || q.length < 1) {
      setHits([])
      return
    }
    let alive = true
    setLoading(true)
    void (async () => {
      try {
        const [articles, entities, summaries] = await Promise.all([
          api.articles({ days: 90, q, limit: 8, includeOfftopic: '1' }),
          api.entities(90, 40),
          api.summaries(30),
        ])
        if (!alive) return
        const out: Hit[] = []
        const lower = q.toLowerCase()
        for (const a of articles.items as Article[]) {
          out.push({
            kind: 'article',
            id: a.id,
            title: a.title,
            context: `${a.sourceName} · ${a.publishedAt.slice(0, 10)}${a.category ? ` · ${a.category}` : ''}`,
            url: a.url,
            date: a.publishedAt.slice(0, 10),
          })
        }
        for (const e of entities.items as EntityItem[]) {
          if (!e.entity.toLowerCase().includes(lower)) continue
          out.push({ kind: 'entity', name: e.entity, title: e.entity, context: `近 90 天被提及 ${e.count} 次`, count: e.count })
        }
        for (const s of (summaries.items as SummaryListItem[]).slice(0, 30)) {
          if (!s.title.toLowerCase().includes(lower)) continue
          out.push({ kind: 'summary', date: s.date, title: s.title, context: `每日简报 · ${s.date}` })
        }
        setHits(out.slice(0, 20))
        setActive(0)
      } catch {
        if (alive) setHits([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, q])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, Math.max(0, hits.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        const hit = hits[active]
        if (!hit) return
        e.preventDefault()
        if (hit.kind === 'article') onNavigate('list', `article:${hit.id}`)
        else if (hit.kind === 'entity') onNavigate('trend', hit.name)
        else onNavigate('summary', hit.date)
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hits, active, onClose, onNavigate])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const grouped = useMemo(() => {
    const map = new Map<Hit['kind'], Hit[]>()
    for (const h of hits) {
      const list = map.get(h.kind) ?? []
      list.push(h)
      map.set(h.kind, list)
    }
    return map
  }, [hits])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="全局检索"
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-2xl dark:bg-[#141821]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-4 py-3">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="搜索文章 / 实体 / 简报…  (↑↓ 选择，回车跳转)"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-slate-900 outline-none placeholder:text-slate-400 dark:text-white"
          />
          {loading && <span className="shrink-0 text-[11px] text-slate-400">搜索中…</span>}
          <kbd className="hidden shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-slate-400 sm:block">Esc</kbd>
        </div>

        {q.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-slate-400">
            输入关键词开始检索 · 覆盖文章、实体与历史简报
          </div>
        ) : hits.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[13px] text-slate-500 dark:text-slate-400">没有找到「{q}」</p>
            <p className="mt-1 text-[11px] text-slate-400">试试更短的关键词，或到「资讯」页用筛选器</p>
          </div>
        ) : (
          <ul ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
            {[...grouped.entries()].flatMap(([kind, list]) =>
              list.map((hit) => {
                const index = hits.indexOf(hit)
                return (
                  <li key={`${hit.kind}-${hit.kind === 'article' ? hit.id : hit.kind === 'entity' ? hit.name : hit.date}`}>
                    <button
                      type="button"
                      data-active={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => {
                        if (hit.kind === 'article') onNavigate('list', `article:${hit.id}`)
                        else if (hit.kind === 'entity') onNavigate('trend', hit.name)
                        else onNavigate('summary', hit.date)
                        onClose()
                      }}
                      className={`flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition ${
                        index === active ? 'bg-slate-50 dark:bg-white/[0.06]' : ''
                      }`}
                    >
                      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${KIND_STYLE[kind]}`}>
                        {KIND_LABEL[kind]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-slate-800 dark:text-slate-100">{hit.title}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-slate-400 dark:text-slate-500">{hit.context}</span>
                      </span>
                      {index === active && (
                        <span className="mt-0.5 hidden shrink-0 text-[10px] text-slate-400 sm:block">回车 ↗</span>
                      )}
                    </button>
                  </li>
                )
              }),
            )}
          </ul>
        )}

        <div className="flex items-center gap-3 border-t border-[var(--line)] px-4 py-2 text-[10.5px] text-slate-400">
          <span>↑↓ 选择</span>
          <span>回车 跳转</span>
          <span>Esc 关闭</span>
          <span className="ml-auto">共 {hits.length} 条</span>
        </div>
      </div>
    </div>
  )
}
