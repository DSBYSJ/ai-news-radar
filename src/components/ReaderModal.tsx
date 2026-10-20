import { useEffect, useRef, useState } from 'react'
import Modal from './Modal.tsx'
import type { ArticleContent } from '../types.ts'
import {
  addHighlight,
  clearSelection,
  getSelectionText,
  highlightColorClass,
  listHighlights,
  removeHighlight,
  renderWithHighlights,
  type Highlight,
} from '../lib/highlights.ts'

interface Props {
  open: boolean
  onClose: () => void
  data: ArticleContent | null
  loading: boolean
  /** 高亮作用域（文章 id / 简报日期）—— 决定 localStorage 里的分组 */
  scope: string
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * 站内阅读器
 *
 * 设计要点：
 * · 正文是纯文本，靠「空行」切段（数据层 htmlToText 已把块级标签转成换行）
 * · 单栏 66ch 行宽 + 1.9 行高 —— 中文长文最舒服的区间，避免整屏横行长文
 * · 顶部细进度条：读长文时知道还剩多少
 * · 原文入口常驻（合规：站内展示的是摘录性全文，必须给回源）
 */
const HIGHLIGHT_COLORS: { key: Highlight['color']; label: string }[] = [
  { key: 'amber', label: '琥珀' },
  { key: 'teal', label: '青' },
  { key: 'slate', label: '灰' },
]

export default function ReaderModal({ open, onClose, data, loading, scope }: Props) {
  const [highlights, setHighlights] = useState<Highlight[]>(() => (scope ? listHighlights(scope) : []))
  const [selText, setSelText] = useState('')
  const [selRect, setSelRect] = useState<{ top: number; left: number } | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (!open) setProgress(0)
  }, [open])

  // 划词选中：记录文本与位置，弹出「高亮」工具条
  const onSelectionChange = (): void => {
    const text = getSelectionText()
    if (!text) {
      setSelText('')
      setSelRect(null)
      return
    }
    const rect = window.getSelection()?.getRangeAt(0)?.getBoundingClientRect()
    setSelText(text)
    setSelRect(rect ? { top: rect.top + window.scrollY, left: rect.left + window.scrollX } : null)
  }

  const doHighlight = (color: Highlight['color']): void => {
    if (!selText) return
    const item = addHighlight(scope, selText, noteDraft, color)
    setHighlights(listHighlights(scope))
    setNoteDraft('')
    setSelText('')
    setSelRect(null)
    clearSelection()
    void item
  }

  const paragraphs = (data?.content ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
      title={
        <div className="min-w-0">
          <p className="eyebrow flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            站内阅读
          </p>
          <p className="num mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400">
            {data ? `${data.sourceName} · ${fmtTime(data.publishedAt)} · ${data.chars} 字` : '正在载入…'}
          </p>
        </div>
      }
    >
      {/* 划词工具条：选中正文后出现（item 10） */}
      {selText && selRect && (
        <div
          className="fixed z-[80] flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white p-2.5 shadow-2xl dark:bg-[#141821]"
          style={{ top: selRect.top - 8, left: Math.max(12, selRect.left - 60) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <p className="max-w-[240px] truncate text-[11px] text-slate-400">「{selText.slice(0, 24)}…」</p>
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="加一句批注（可留空）"
            className="w-56 rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-[11.5px] dark:bg-white/[0.04]"
          />
          <div className="flex items-center gap-1.5">
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => doHighlight(c.key)}
                className={`rounded px-2 py-1 text-[11px] text-slate-700 dark:text-slate-200 ${highlightColorClass(c.key)}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 我的批注（仅本地） */}
      {highlights.length > 0 && (
        <div className="mb-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2.5">
          <p className="eyebrow mb-1.5 text-[10px] text-slate-400 dark:text-slate-500">
            我的批注 · {highlights.length} 条（只存在本机）
          </p>
          <ul className="space-y-1.5">
            {highlights.map((h) => (
              <li key={h.id} className="flex items-start gap-2 text-[11.5px] leading-snug">
                <span className={`mt-0.5 h-3 w-1 shrink-0 rounded ${highlightColorClass(h.color)}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-slate-600 dark:text-slate-300">{h.text}</span>
                  {h.note && <span className="mt-0.5 block text-[11px] text-[var(--accent)]">批注：{h.note}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    removeHighlight(scope, h.id)
                    setHighlights(listHighlights(scope))
                  }}
                  className="shrink-0 text-[10.5px] text-slate-400 hover:text-red-600"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 进度条 */}
      <div className="mb-3 h-0.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div
        ref={scrollRef}
        onMouseUp={onSelectionChange}
        onScroll={(e) => {
          const el = e.currentTarget
          const max = el.scrollHeight - el.clientHeight
          setProgress(max > 0 ? Math.min(100, Math.round((el.scrollTop / max) * 100)) : 100)
        }}
        className="max-h-[70vh] overflow-y-auto pr-1"
      >
        {loading && (
          <div className="space-y-2.5 py-2">
            {[92, 86, 78, 90, 62].map((w, i) => (
              <div key={i} className="h-3.5 animate-pulse rounded bg-slate-100 dark:bg-white/5" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}

        {!loading && !data && (
          <p className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">正文加载失败，请打开原文阅读。</p>
        )}

        {!loading && data && (
          <article className="mx-auto max-w-[66ch]">
            <h1 className="text-[20px] font-semibold leading-snug tracking-tight text-slate-900 dark:text-white sm:text-[22px]">
              {data.title}
            </h1>

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
              <span className="font-medium text-slate-500 dark:text-slate-400">{data.sourceName}</span>
              <span className="num">{fmtTime(data.publishedAt)}</span>
              <span className="num">· {data.chars} 字</span>
            </div>

            <hr className="my-4 border-[var(--line)]" />

            {paragraphs.length > 0 ? (
              <div className="space-y-4">
                {paragraphs.map((p, i) => (
                  <p
                    key={i}
                    className="text-[15px] leading-[1.9] text-slate-700 [text-align:justify] dark:text-slate-200"
                  >
                    {renderWithHighlights(p, highlights).map((seg, j) =>
                      seg.hit ? (
                        <mark key={j} className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/25">
                          {seg.text}
                        </mark>
                      ) : (
                        <span key={j}>{seg.text}</span>
                      ),
                    )}
                  </p>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                该源只提供摘要，没有全文可读。
              </p>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-3">
              <a
                href={data.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
              >
                阅读原文
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7M9 7h8v8" />
                </svg>
              </a>
              <span className="text-[10px] text-slate-400 dark:text-slate-500">
                站内为纯文本（无图无外链），版权归原作者 · 仅个人阅读
              </span>
            </div>
          </article>
        )}
      </div>
    </Modal>
  )
}
