import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api.ts'
import { useBurstFeed } from './hooks/useBurstFeed.ts'
import ListPage from './pages/ListPage.tsx'
import OverviewPage from './pages/OverviewPage.tsx'
import SummaryPage from './pages/SummaryPage.tsx'
import TrendPage from './pages/TrendPage.tsx'
import type { Health, SourceItem } from './types.ts'
import { CATEGORY_LABELS } from './utils/format.ts'

type Tab = 'overview' | 'list' | 'trend' | 'summary'
type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const saved = localStorage.getItem('theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      {children}
    </span>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [health, setHealth] = useState<Health | null>(null)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [running, setRunning] = useState<string>('')
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])

  // 突发实时推送（WebSocket）：采集到 z ≥ 2.5 的新突发时立即弹提示
  const { connected } = useBurstFeed((items) => {
    setToasts((prev) =>
      [
        ...prev,
        ...items.map((it, i) => ({
          id: Date.now() + i,
          text: `${it.date} · ${it.category === 'all' ? '全站' : (CATEGORY_LABELS[it.category] ?? it.category)} · ${it.articleCount} 条（基线 ${it.baseline}, z=${it.z}）${it.test ? '（测试）' : ''}`,
        })),
      ].slice(-3),
    )
  })

  // 提示 12 秒后自动消失
  useEffect(() => {
    if (toasts.length === 0) return
    const timer = setTimeout(() => setToasts((prev) => prev.slice(1)), 12_000)
    return () => clearTimeout(timer)
  }, [toasts])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('theme', theme)
  }, [theme])

  const loadMeta = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([api.health(), api.sources()])
      setHealth(h)
      setSources(s.items)
    } catch {
      // 后端未启动时静默降级，页面仍可打开并给出提示
    }
  }, [])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  const run = async (kind: 'collect' | 'process') => {
    setRunning(kind === 'collect' ? '采集中…' : '加工中…')
    try {
      if (kind === 'collect') await api.runCollect()
      else await api.runProcess()
      await loadMeta()
      setRunning(kind === 'collect' ? '采集完成' : '加工完成')
    } catch (e) {
      setRunning(e instanceof Error ? e.message : '失败')
    } finally {
      setTimeout(() => setRunning(''), 3000)
    }
  }

  const actionBtn =
    'rounded-full border border-slate-300 bg-white px-3.5 py-1.5 text-xs text-slate-700 transition duration-150 ' +
    'hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 ' +
    'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-500'

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <header className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              AI 资讯趋势雷达
            </h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              不是资讯阅读器 —— 看的是「变化」：哪个方向在升温，哪些事件被多家独立源印证
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void run('collect')} disabled={running !== ''} className={actionBtn}>
              采集
            </button>
            <button type="button" onClick={() => void run('process')} disabled={running !== ''} className={actionBtn}>
              加工
            </button>
            <button
              type="button"
              aria-label="切换深色模式"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              className={actionBtn}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {health ? (
            <>
              <Pill>v{health.version}</Pill>
              <Pill>源 {health.sources}</Pill>
              <Pill>原始 {health.rawItems}</Pill>
              <Pill>成品 {health.articles}</Pill>
              <Pill>事件 {health.events}</Pill>
              <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${health.aiEnabled ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                AI {health.aiEnabled ? '已启用' : '未配置（启发式兜底）'}
              </span>
              <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${health.authEnabled ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                鉴权 {health.authEnabled ? '已开启' : '未开启（本地）'}
              </span>
              <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                />
                实时推送 {connected ? '已连接' : '未连接'}
              </span>
            </>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">后端未连接（先启动 server：cd server && npm start）</span>
          )}
          {running && <span className="text-slate-600 dark:text-slate-300">{running}</span>}
        </div>

        <nav className="mt-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {(
            [
              ['overview', '概览'],
              ['list', '资讯'],
              ['trend', '趋势'],
              ['summary', '简报'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`-mb-px rounded-t-lg border-b-2 px-3.5 py-2 text-sm transition ${
                tab === key
                  ? 'border-violet-600 font-medium text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'overview' ? (
        <OverviewPage health={health} onNavigate={setTab} />
      ) : tab === 'list' ? (
        <ListPage sources={sources} />
      ) : tab === 'trend' ? (
        <TrendPage />
      ) : (
        <SummaryPage />
      )}

      {/* 突发实时推送提示（右下角浮层） */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="rounded-xl border border-red-200 bg-white p-3 shadow-lg dark:border-red-900/60 dark:bg-slate-900"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                突发（实时推送）
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-700 dark:text-slate-200">{t.text}</p>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                className="mt-1.5 text-[11px] text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-300"
              >
                知道了
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
