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

    // 安卓壳：状态栏图标颜色跟随站内主题（浏览器里没有插件，静默跳过）。
    // Capacitor 的命名习惯：style 'DARK' = 深色背景用浅色图标，'LIGHT' = 浅色背景用深色图标。
    const statusBar = (
      window as unknown as {
        Capacitor?: { Plugins?: { StatusBar?: { setStyle?: (o: { style: string }) => Promise<void> } } }
      }
    ).Capacitor?.Plugins?.StatusBar
    statusBar?.setStyle?.({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {})
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
    'rounded-lg border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs text-slate-600 backdrop-blur transition ' +
    'hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 ' +
    'dark:border-white/10 dark:bg-white/5 dark:text-slate-300 dark:hover:border-white/25 dark:hover:text-white'

  const statusDot = (ok: boolean) => `inline-block h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`

  // 安全区适配（安卓 App edge-to-edge 下避让状态栏与手势区；桌面端 env() 为 0，不受影响）
  return (
    <div className="mx-auto max-w-5xl overflow-x-hidden px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)] md:px-6 md:pb-[calc(env(safe-area-inset-bottom)+2rem)] md:pt-[calc(env(safe-area-inset-top)+1.75rem)]">
      <header className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* 品牌标：渐变瓷片 + 走势线 */}
            <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[13px] bg-gradient-to-br from-violet-500 via-violet-600 to-indigo-600 shadow-[0_10px_24px_-12px_rgba(109,40,217,0.9)] ring-1 ring-white/25">
              <span className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(255,255,255,0.45),transparent_58%)]" />
              <svg
                viewBox="0 0 24 24"
                className="absolute inset-0 m-auto h-5 w-5 text-white"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3.5 16.5l4.5-4.5 3.5 3 8-8.5" />
                <circle cx="19.5" cy="6.5" r="1.9" fill="currentColor" stroke="none" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-slate-900 dark:text-white">
                  AI 资讯趋势雷达
                </h1>
                {health && (
                  <span className="rounded-full border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
                    v{health.version}
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400">
                看的是「变化」：哪个方向在升温，哪些事件被多家独立源印证
              </p>
            </div>
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

        {/* 运行状态：一行细字，用竖线分隔，不抢视线 */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          {health ? (
            <>
              <span className="num">源 {health.sources}</span>
              <span className="h-3 w-px bg-slate-200 dark:bg-white/10" />
              <span className="num">原始 {health.rawItems}</span>
              <span className="h-3 w-px bg-slate-200 dark:bg-white/10" />
              <span className="num">成品 {health.articles}</span>
              <span className="h-3 w-px bg-slate-200 dark:bg-white/10" />
              <span className="num">事件 {health.events}</span>
              <span className="h-3 w-px bg-slate-200 dark:bg-white/10" />
              <span className="flex items-center gap-1.5">
                <span className={statusDot(health.aiEnabled)} />
                AI {health.aiEnabled ? '已启用' : '未配置'}
              </span>
              <span className="flex items-center gap-1.5">
                <span className={statusDot(health.authEnabled)} />
                鉴权 {health.authEnabled ? '已开启' : '未开启'}
              </span>
              <span className="flex items-center gap-1.5">
                <span className={statusDot(connected)} />
                推送 {connected ? '已连接' : '未连接'}
              </span>
            </>
          ) : (
            <span>后端未连接（先启动 server：cd server && npm start）</span>
          )}
          {health?.latestDate && (
            <span
              className={
                health.latestDate === new Date().toISOString().slice(0, 10) ? '' : 'text-amber-600 dark:text-amber-400'
              }
              title="库内最新一条成品的日期（UTC）；采集每天 5 个时间点，非当天说明最近一轮还没跑或失败了"
            >
              数据截至 {health.latestDate.slice(5)}
              {health.latestDate === new Date().toISOString().slice(0, 10) ? '（当天）' : '（非当天）'}
            </span>
          )}
          {running && <span className="text-slate-700 dark:text-slate-200">{running}</span>}
        </div>

        {/* 页签：分段控件（选中项自带一层高光，深色下也不糊） */}
        <nav className="mt-4 inline-flex rounded-xl border border-slate-200/80 bg-slate-100/70 p-1 backdrop-blur dark:border-white/10 dark:bg-white/[0.04]">
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
              className={`rounded-lg px-3.5 py-1.5 text-sm transition ${
                tab === key
                  ? 'bg-white font-medium text-slate-900 shadow-sm ring-1 ring-black/5 dark:bg-white/10 dark:text-white dark:ring-white/10'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
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
        <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
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
