import { useState } from 'react'
import type { Article } from '../types.ts'
import { CATEGORY_COLORS, formatDateTime, scoreColor } from '../utils/format.ts'

/**
 * 多级信息深度（借鉴 ai-pulse）：
 *   L1 TL;DR 一句话 → L2 标题 + 标签（分类/来源/时间）→ L3 摘要 → L4 实体 + 原文链接
 * 默认只展示 L1+L2，点开才展开 L3/L4 —— 一屏能扫更多条。
 */
export default function ArticleCard({ article }: { article: Article }) {
  const [open, setOpen] = useState(false)

  return (
    <article className="card p-4 transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span
          className="rounded-full px-2 py-0.5 font-medium text-white"
          style={{ backgroundColor: scoreColor(article.score) }}
        >
          {article.score ?? '-'} 分
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-white"
          style={{ backgroundColor: CATEGORY_COLORS[article.category] ?? '#9ca3af' }}
        >
          {article.categoryLabel}
        </span>
        <span className="text-slate-500 dark:text-slate-400">{article.sourceName}</span>
        <span className="text-slate-400 dark:text-slate-500">{formatDateTime(article.publishedAt)}</span>
        {article.sourceCount && article.sourceCount >= 2 ? (
          <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400">
            {article.sourceCount} 家源报道
          </span>
        ) : null}
      </div>

      <h2 className="text-[15px] font-semibold leading-snug text-slate-900 dark:text-slate-100">
        <a href={article.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          {article.title}
        </a>
      </h2>

      {article.tldr && <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{article.tldr}</p>}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 text-xs text-slate-500 underline decoration-dotted transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
      >
        {open ? '收起详情' : '展开摘要与实体'}
      </button>

      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
          {article.summary ? (
            <p className="leading-relaxed">{article.summary}</p>
          ) : (
            <p className="text-slate-400 dark:text-slate-500">（暂无摘要）</p>
          )}
          {article.entities.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {article.entities.map((e) => (
                <span
                  key={e}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
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
            className="mt-2 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            阅读原文 →
          </a>
        </div>
      )}
    </article>
  )
}
