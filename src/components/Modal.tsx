import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  /** 标题区（左），通常放徽章 + 标题 */
  title?: ReactNode
  /** 标题下方的说明行 */
  subtitle?: ReactNode
  children: ReactNode
  /** 面板最大宽度类，默认 max-w-3xl */
  maxWidthClass?: string
}

/**
 * 通用弹窗（遮罩 + 面板）：
 * - 手机端优先：内边距与安全区配合，面板可滚动，不会顶到状态栏/手势条
 * - 点遮罩或按 Esc 关闭；打开时锁定页面滚动
 */
export default function Modal({ open, onClose, title, subtitle, children, maxWidthClass = 'max-w-3xl' }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  /*
   * ⚠️ 必须用 portal 挂到 document.body。
   * 页面内容包在 .page-enter 里（页签切换动画），它带的 transform 会成为
   * position:fixed 后代的**包含块** —— 遮罩会缩成内容区大小、只盖住一小块，
   * 页面标题等内容依然可见并与弹窗文字重叠（实际出现过这个 bug）。
   * 挂到 body 才能保证 fixed 相对视口定位、且不受祖先层叠上下文影响。
   */
  return createPortal(
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/70 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-sm sm:p-4 sm:pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pt-[calc(1rem+env(safe-area-inset-top))]"
      onClick={onClose}
    >
      <div
        className={`mx-auto w-full ${maxWidthClass} card p-4 shadow-2xl sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            关闭
          </button>
        </header>
        {subtitle}
        {children}
      </div>
    </div>,
    document.body,
  )
}
