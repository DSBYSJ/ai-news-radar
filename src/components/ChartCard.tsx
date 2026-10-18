import { useState } from 'react'
import type { ReactNode } from 'react'
import Modal from './Modal.tsx'

interface Props {
  level: string
  title: string
  hint?: string
  badge?: ReactNode
  children: ReactNode
}

/** 放大倍率（SVG 是矢量，transform 缩放不会糊） */
const ZOOM = 1.6

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
    </svg>
  )
}

/** 图表卡片：紫色层级标签 + 标题 + 徽章 + 注释；右上角按钮 / 点击标题可全屏放大细看（Esc 由 Modal 统一处理） */
export default function ChartCard({ level, title, hint, badge, children }: Props) {
  const [zoomed, setZoomed] = useState(false)

  return (
    <>
      <section className="group relative card p-5">
        {/* pr-10：给右上角的绝对定位放大按钮预留位置，避免长标题压到按钮下面 */}
        <header className="mb-4 flex flex-wrap items-center gap-2 pr-10">
          <button
            type="button"
            onClick={() => setZoomed(true)}
            title="放大查看（Esc 关闭）"
            className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-medium text-white"
          >
            {level}
          </button>
          <button
            type="button"
            onClick={() => setZoomed(true)}
            title="放大查看"
            className="text-left text-base font-semibold text-slate-900 hover:text-violet-700 hover:underline dark:text-slate-100 dark:hover:text-violet-300"
          >
            {title}
          </button>
          {badge && <span className="ml-auto">{badge}</span>}
          <button
            type="button"
            onClick={() => setZoomed(true)}
            title="放大查看（Esc 关闭）"
            aria-label="放大查看"
            className="absolute right-4 top-4 rounded-lg border border-slate-200 p-1.5 text-slate-400 opacity-60 transition hover:border-violet-400 hover:text-violet-600 focus:opacity-100 group-hover:opacity-100 dark:border-slate-700 dark:hover:border-violet-500 dark:hover:text-violet-300"
          >
            <ExpandIcon />
          </button>
          {hint && <p className="w-full text-xs leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p>}
        </header>
        {children}
      </section>

      <Modal
        open={zoomed}
        onClose={() => setZoomed(false)}
        maxWidthClass="max-w-6xl"
        title={
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-medium text-white">{level}</span>
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