import { useState } from 'react'
import type { Article } from '../types.ts'
import { CATEGORY_COLORS, formatDateTime, scoreColor } from '../utils/format.ts'

/**
 * 资讯卡：一屏能扫，但每一条都"有质感"。
 *
 * 信息层次（自上而下）：
 *   左侧色条 = 分类（颜色是分类的指纹，扫视时先认颜色）
 *   第一行 = 分数 + 分类 + 源 + 时间（弱化，不抢标题）
 *   标题   = 唯一的大字，可点击
 *   TL;DR  = 一句灰色说明
 *   底部   = 跨源徽章 / 展开详情 / 原文
 *
 * 交互：整张卡悬停上浮；展开区用 grid-template-rows 过渡（内容高度不定也能顺滑展开）。
 */
export default function ArticleCard({ article }: { article: Article }) {
  const [open, setOpen] = useState(false)
  const accent = CATEGORY_COLORS[article.category] ?? '#9aa3ad'
  const crossSource = article.sourceCount !== null && article.sourceCount >= 2

  return (
    <article className="card card-hover group relative overflow-hidden">
      {/* 分类色条：视觉锚点 */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px] transition-opacity duration-300 group-hover:opacity-100"
        style={{ backgroundColor: accent, opacity: 0.85 }}
      />

      <div className="pl-5 pr-4 py-3.5">
        {/* 元信息行 */}
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span
            className="num inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-sm"
            style={{ backgroundColor: scoreColor(article.score) }}
            title="重要度评分（0-100）"
          >
            {article.score ?? '–'}
          </span>
          <span
            className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium"
            style={{ color: accent, backgroundColor: `${accent}14` }}
          >
            {article.categoryLabel}
          </span>
          <span className="text-slate-400 dark:text-slate-500">·</span>
          <span className="font-medium text-slate-500 dark:text-slate-400">{article.sourceName}</span>
          <span className="num text-slate-400 dark:text-slate-500">{formatDateTime(article.publishedAt)}</span>

          {crossSource && (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600 ring-1 ring-red-100 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20">
              <span className="inline-block h-1 w-1 rounded-full bg-current" />
              {article.sourceCount} 家源报道
            </span>
          )}
        </div>

        {/* 标题：全卡唯一的大字 */}
        <h2 className="text-[15px] font-semibold leading-snug tracking-[-0.01em] text-slate-900 dark:text-slate-50">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-violet-700 dark:hover:text-violet-300"
          >
            {article.title}
          </a>
        </h2>

        {article.tldr && (
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{article.tldr}</p>
        )}

        {/* 展开控制 */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-slate-400 transition-colors hover:text-violet-700 dark:hover:text-violet-300"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-3 w-3 transition-transform duration-300 ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          {open ? '收起' : '摘要与实体'}
        </button>

        {/* 详情：grid 0fr→1fr，展开动画不依赖固定高度 */}
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-out"
          style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        >
          <div className="overflow-hidden">
            <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-3 dark:border-white/[0.07]">
              <p className="text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
                {article.summary || <span className="text-slate-400 dark:text-slate-500">（暂无摘要）</span>}
              </p>

              {article.entities.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {article.entities.map((e) => (
                    <span
                      key={e}
                      className="chip !text-[11px] transition-colors hover:!border-violet-300 hover:!text-violet-700 dark:hover:!border-violet-500/40 dark:hover:!text-violet-300"
                    >
                      {e}
                    </span>
                  ))}
                </div>
              )}

              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] font-medium text-violet-700 transition-colors hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
              >
                阅读原文
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7M9 7h8v8" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}
