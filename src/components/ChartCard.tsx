import { useState } from 'react'
import type { ReactNode } from 'react'
import Modal from './Modal.tsx'

/**
 * 图表卡
 *
 * v0.35.0 改动：`level` 原本传「第 1 层 / 第 2 层」这种编号，但编号本身不携带信息 ——
 * 用户看到「第 2 层」并不知道它是什么意思，而且卡片数（5）和「四层递进」的说法（4）对不上。
 * 现在改成**语义标签**（基线 / 构成 / 趋势 / 异常 / 情绪 / 实体），并用 `tone` 给不同类别上色，
 * 让读者扫一眼就能分辨"这张卡在回答什么问题"。
 */

export type CardTone = 'base' | 'mix' | 'trend' | 'alert' | 'mood' | 'entity'

const TONE_STYLE: Record<CardTone, string> = {
  base: 'from-slate-500 to-slate-600 shadow-[0_4px_10px_-4px_rgba(71,85,105,0.7),inset_0_1px_0_rgba(255,255,255,0.25)]',
  mix: 'from-sky-500 to-sky-600 shadow-[0_4px_10px_-4px_rgba(2,132,199,0.7),inset_0_1px_0_rgba(255,255,255,0.25)]',
  trend: 'from-violet-500 to-violet-600 shadow-[0_4px_10px_-4px_rgba(109,40,217,0.8),inset_0_1px_0_rgba(255,255,255,0.3)]',
  alert: 'from-amber-500 to-orange-600 shadow-[0_4px_10px_-4px_rgba(217,119,6,0.7),inset_0_1px_0_rgba(255,255,255,0.25)]',
  mood: 'from-emerald-500 to-emerald-600 shadow-[0_4px_10px_-4px_rgba(5,150,105,0.7),inset_0_1px_0_rgba(255,255,255,0.25)]',
  entity: 'from-teal-500 to-cyan-600 shadow-[0_4px_10px_-4px_rgba(13,148,136,0.7),inset_0_1px_0_rgba(255,255,255,0.25)]',
}

interface Props {
  /** 语义标签（如「基线」「构成」），不是编号 */
  level: string
  title: string
  hint?: string
  badge?: ReactNode
  tone?: CardTone
  children: ReactNode
}

/** 放大倍率（SVG 是矢量，缩放不会糊） */
const ZOOM = 1.6

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
    </svg>
  )
}

export default function ChartCard({ level, title, hint, badge, tone = 'trend', children }: Props) {
  const [zoomed, setZoomed] = useState(false)

  return (
    <>
      <section className="card card-hover group relative p-5">
        <header className="mb-4">
          <div className="flex items-start gap-2.5 pr-9">
            <span
              className={`mt-px shrink-0 rounded-md bg-gradient-to-b px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white ${TONE_STYLE[tone]}`}
            >
              {level}
            </span>
            <button
              type="button"
              onClick={() => setZoomed(true)}
              title="放大查看"
              className="min-w-0 flex-1 text-left text-[15px] font-semibold leading-snug tracking-[-0.01em] text-slate-900 transition-colors hover:text-violet-700 dark:text-slate-100 dark:hover:text-violet-300"
            >
              {title}
            </button>
            {badge && <span className="shrink-0">{badge}</span>}
          </div>

          {hint && (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-400 dark:text-slate-500">{hint}</p>
          )}
        </header>

        <button
          type="button"
          onClick={() => setZoomed(true)}
          title="放大查看（Esc 关闭）"
          aria-label="放大查看"
          className="absolute right-3.5 top-3.5 rounded-md border border-slate-200/80 p-1.5 text-slate-400 opacity-0 transition-all duration-200 hover:border-violet-400 hover:text-violet-600 focus-visible:opacity-100 group-hover:opacity-100 dark:border-white/10 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
        >
          <ExpandIcon />
        </button>

        {children}
      </section>

      <Modal
        open={zoomed}
        onClose={() => setZoomed(false)}
        maxWidthClass="max-w-6xl"
        title={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-md bg-gradient-to-b px-1.5 py-0.5 text-[10px] font-semibold text-white ${TONE_STYLE[tone]}`}
            >
              {level}
            </span>
            <h3 className="text-base font-semibold leading-snug text-slate-900 dark:text-slate-100">{title}</h3>
            {badge}
          </div>
        }
        subtitle={hint ? <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : undefined}
      >
        {/* 放大：用 zoom 而非 transform:scale —— zoom 会同时放大「视觉」与「布局尺寸」，
            容器高度跟着变，既不会横向溢出、底部也不会被裁掉（Chromium / Safari / Firefox 126+ 均支持） */}
        <div style={{ zoom: ZOOM }}>{children}</div>
      </Modal>
    </>
  )
}
