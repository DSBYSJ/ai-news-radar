import { useState } from 'react'
import type { Article } from '../types.ts'
import { CATEGORY_COLORS, formatDateTime } from '../utils/format.ts'

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

      <div className="py-3 pl-[18px] pr-4">
        {/* 元信息行 */}
        <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">
          <span
            className="num inline-flex h-[18px] min-w-[26px] items-center justify-center rounded text-[10.5px] font-bold tabular-nums"
            style={
              (article.score ?? 0) >= 60
                ? { backgroundColor: '#fef2f2', color: '#b91c1c' }
                : (article.score ?? 0) >= 40
                  ? { backgroundColor: '#fffbeb', color: '#b45309' }
                  : { backgroundColor: '#f1f5f9', color: '#64748b' }
            }
            title={`重要度 ${article.score ?? '–'} / 100`}
          >
            {article.score ?? '–'}
          </span>
          <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{article.categoryLabel}</span>
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
        <div className="flex items-start gap-1.5">
          <h2 className="min-w-0 flex-1 text-[15px] font-semibold leading-[1.45] tracking-[-0.011em] text-slate-900 dark:text-slate-50">
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-violet-700 dark:hover:text-violet-300"
            >
              {article.title}
            </a>
          </h2>
          {/* 展开开关：收进标题行右侧，省掉原来单独一行的纵向空间 */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? '收起详情' : '展开摘要与实体'}
            title={open ? '收起详情' : '展开摘要与实体'}
            className="mt-[3px] shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-violet-600 dark:text-slate-600 dark:hover:bg-white/5 dark:hover:text-violet-300"
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-3.5 w-3.5 transition-transform duration-300 ${open ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>

        {article.tldr && (
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{article.tldr}</p>
        )}


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
