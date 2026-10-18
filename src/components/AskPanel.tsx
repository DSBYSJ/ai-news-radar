import { useState } from 'react'
import type { AskResult, AskSource } from '../types.ts'
import { api } from '../api.ts'

/** 引用来源列表（可点击原文；被回答真正引用的编号高亮） */
function SourceList({ sources, cited }: { sources: AskSource[]; cited?: number[] }) {
  if (sources.length === 0) return null
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <p className="mb-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
        引用来源（{sources.length}）
        {cited && cited.length > 0 ? ` · 回答引用了 [${cited.join('][')}]` : ''}
      </p>
      <ul className="space-y-1.5">
        {sources.map((s) => {
          const isCited = cited?.includes(s.index) ?? false
          return (
            <li key={s.index} className="text-xs leading-snug">
              <span
                className={`mr-1 inline-block rounded px-1 py-0.5 text-[10px] ${
                  isCited
                    ? 'bg-violet-600 text-white'
                    : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                }`}
              >
                {s.index}
              </span>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-700 hover:text-violet-700 hover:underline dark:text-slate-200 dark:hover:text-violet-300"
              >
                {s.title}
              </a>
              <span className="ml-1 text-[10px] text-slate-400 dark:text-slate-500">
                {s.sourceName} · {s.date}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface Msg {
  id: number
  role: 'user' | 'assistant'
  text?: string
  result?: AskResult
  error?: string
}

const EXAMPLES = ['本周开源项目类文章有几篇？', '为什么 10-13 号 AI 芯片热度飙升？']

/**
 * AI 助手面板（自用）：
 * - 统计类问题 → 后端 Text-to-SQL 给出**来自 SQL 结果**的数字；
 * - 归因类问题 → 向量检索 Top5 + 当天统计上下文 → 归因分析，引用可点击。
 * 前端只负责展示，不做任何数字加工（反编造在服务端完成）。
 */
export default function AskPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  // 手机端默认折叠（不占首屏）；桌面端始终展开
  const [collapsed, setCollapsed] = useState(false)

  const send = async (question: string) => {
    const q = question.trim()
    if (!q || loading) return
    const userMsg: Msg = { id: Date.now(), role: 'user', text: q }
    setMsgs((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)
    try {
      const result = await api.ask(q)
      setMsgs((prev) => [...prev, { id: Date.now() + 1, role: 'assistant', result }])
    } catch (e) {
      setMsgs((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'assistant', error: e instanceof Error ? e.message : String(e) },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="card">
      <header className="flex items-start gap-2 border-b border-slate-100 p-4 dark:border-slate-800">
        <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-medium text-white">AI</span>
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">趋势问答助手</h3>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          统计类问题走 Text-to-SQL，归因类问题走向量检索 + 当天统计上下文。
          <b className="text-slate-600 dark:text-slate-300">所有数字来自库内查询，所有引用都指向真实文章</b>，不会编造。
        </p>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="shrink-0 rounded-full border border-slate-300 px-2.5 py-1 text-[11px] text-slate-600 lg:hidden dark:border-slate-700 dark:text-slate-300"
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </header>

      <div className={collapsed ? 'hidden lg:block' : ''}>
      <div className="max-h-[52vh] space-y-3 overflow-y-auto p-4 lg:max-h-[420px]">
        {msgs.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">试试这两个问题：</p>
            {EXAMPLES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void send(q)}
                className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-600 transition hover:border-violet-400 hover:bg-violet-50/40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-violet-500"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {msgs.map((m) =>
          m.role === 'user' ? (
            <p
              key={m.id}
              className="ml-auto w-fit max-w-[90%] rounded-xl rounded-br-sm bg-slate-900 px-3 py-2 text-sm text-white dark:bg-slate-700"
            >
              {m.text}
            </p>
          ) : (
            <div key={m.id} className="space-y-2">
              {m.error ? (
                <p className="rounded-lg bg-red-50 p-3 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
                  请求失败：{m.error}
                </p>
              ) : (
                m.result && (
                  <>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium text-white ${
                          m.result.kind === 'stats' ? 'bg-sky-600' : 'bg-violet-600'
                        }`}
                      >
                        {m.result.kind === 'stats' ? '统计 · SQL' : '归因 · 检索'}
                      </span>
                      {m.result.mode === 'fallback' && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
                          降级模式{m.result.note ? `（${m.result.note}）` : ''}
                        </span>
                      )}
                    </div>

                    <div className="whitespace-pre-wrap rounded-xl rounded-bl-sm bg-slate-50 p-3 text-sm leading-relaxed text-slate-800 dark:bg-slate-800/60 dark:text-slate-100">
                      {m.result.answer}
                    </div>

                    {m.result.sql && (
                      <details className="rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
                        <summary className="cursor-pointer text-slate-500 dark:text-slate-400">查看执行的 SQL</summary>
                        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-slate-600 dark:text-slate-300">
                          {m.result.sql}
                        </pre>
                      </details>
                    )}

                    {m.result.sources.length > 0 && (
                      <SourceList sources={m.result.sources} cited={m.result.cited} />
                    )}
                  </>
                )
              )}
            </div>
          ),
        )}

        {loading && (
          <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600" />
            正在查库并组织回答…
          </p>
        )}
      </div>

      <div className="border-t border-slate-100 p-3 dark:border-slate-800">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(input)
            }}
            placeholder="问点什么，如：本周融资类有几篇？"
            disabled={loading}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-violet-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <button
            type="button"
            onClick={() => void send(input)}
            disabled={loading || input.trim() === ''}
            className="shrink-0 rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
          >
            提问
          </button>
        </div>
      </div>
      </div>
    </section>
  )
}