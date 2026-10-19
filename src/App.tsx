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

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-3.5 w-3.5 ${spinning ? 'animate-spin' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  )
}

/** 状态条里的一个读数：标签小字 + 等宽数字 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="opacity-70">{label}</span>
      <span className="num font-semibold text-slate-800 dark:text-slate-100">{value.toLocaleString('en-US')}</span>
    </span>
  )
}

function Divider() {
  return <span className="hidden h-3 w-px bg-slate-200 sm:block dark:bg-white/10" />
}

/** 状态指示：圆点 + 文案（未启用时点变灰，不喧宾夺主） */
function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          on ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.16)]' : 'bg-slate-300 dark:bg-slate-600'
        }`}
      />
      {label}
    </span>
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

  // 按钮三态：主操作（实心渐变）/ 次操作（描边玻璃）/ 图标
  const btnBase =
    'inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium transition duration-200 disabled:cursor-not-allowed disabled:opacity-50 '
  const btnPrimary =
    btnBase +
    'bg-gradient-to-b from-violet-500 to-violet-600 px-3.5 py-1.5 text-white shadow-[0_6px_16px_-8px_rgba(109,40,217,0.9),inset_0_1px_0_rgba(255,255,255,0.28)] ' +
    'hover:from-violet-500 hover:to-violet-500 hover:shadow-[0_10px_22px_-8px_rgba(109,40,217,0.85)] active:translate-y-px'
  const btnGhost =
    btnBase +
    'border border-slate-200/90 bg-white/70 px-3.5 py-1.5 text-slate-600 backdrop-blur hover:border-slate-300 hover:text-slate-900 ' +
    'dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-white/25 dark:hover:text-white'
  const btnIcon =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200/90 bg-white/70 text-slate-500 backdrop-blur transition ' +
    'hover:border-slate-300 hover:text-slate-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400 dark:hover:border-white/25 dark:hover:text-white'

  // 安全区适配（安卓 App edge-to-edge 下避让状态栏与手势区；桌面端 env() 为 0，不受影响）
  return (
    <div className="mx-auto max-w-6xl overflow-x-hidden px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)] md:px-6 md:pt-[calc(env(safe-area-inset-top)+1.75rem)]">
      <header className="mb-6">
        {/* ===== 品牌行 ===== */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            {/* 品牌标：渐变瓷片 + 走势线 + 内高光 */}
            <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[14px] bg-gradient-to-br from-violet-500 via-violet-600 to-indigo-600 shadow-[0_14px_30px_-14px_rgba(109,40,217,0.95)] ring-1 ring-white/30">
              <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_16%,rgba(255,255,255,0.5),transparent_60%)]" />
              <span className="absolute inset-x-0 bottom-0 h-1/2 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.22))]" />
              <svg
                viewBox="0 0 24 24"
                className="absolute inset-0 m-auto h-5 w-5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
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
                <h1 className="text-[23px] font-semibold leading-none tracking-[-0.03em] text-slate-900 dark:text-white">
                  AI 资讯趋势雷达
                </h1>
                {health && (
                  <span className="chip num" title="当前版本">
                    v{health.version}
                  </span>
                )}
                {health?.latestDate && (
                  <span
                    className={`chip num ${
                      health.latestDate === new Date().toISOString().slice(0, 10)
                        ? ''
                        : '!border-amber-300/60 !text-amber-700 dark:!border-amber-500/30 dark:!text-amber-400'
                    }`}
                    title="库内最新一条成品的日期（UTC）；采集每天 5 个时间点，非当天说明最近一轮还没跑或失败了"
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        health.latestDate === new Date().toISOString().slice(0, 10)
                          ? 'bg-emerald-500'
                          : 'bg-amber-500'
                      }`}
                    />
                    数据截至 {health.latestDate.slice(5)}
                  </span>
                )}
              </div>
              <p className="mt-1.5 truncate text-[12px] text-slate-500 dark:text-slate-400">
                看的是「变化」：哪个方向在升温，哪些事件被多家独立源印证
              </p>
            </div>
          </div>

          {/* 操作区：主次分明（主按钮实心，次按钮描边） */}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void run('collect')} disabled={running !== ''} className={btnPrimary}>
              <RefreshIcon spinning={running === '采集中…'} />
              采集
            </button>
            <button type="button" onClick={() => void run('process')} disabled={running !== ''} className={btnGhost}>
              <SparkIcon />
              加工
            </button>
            <button
              type="button"
              aria-label="切换深色模式"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              className={btnIcon}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>

        {/* ===== 状态条：等宽数字 + 细分隔。不是"彩色胶囊堆叠"，而是仪表盘读数 ===== */}
        <div className="status-bar mt-4 flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-xl border border-slate-200/70 bg-white/60 px-3 py-2 text-[11px] text-slate-500 backdrop-blur-md dark:text-slate-400">
          {health ? (
            <>
              <Stat label="源" value={health.sources} />
              <Divider />
              <Stat label="原始" value={health.rawItems} />
              <Divider />
              <Stat label="成品" value={health.articles} />
              <Divider />
              <Stat label="事件" value={health.events} />
              <Divider />
              <Flag on={health.aiEnabled} label={`AI ${health.aiEnabled ? '已启用' : '未配置'}`} />
              <Flag on={health.authEnabled} label={`鉴权 ${health.authEnabled ? '已开启' : '未开启'}`} />
              <Flag on={connected} label={`推送 ${connected ? '已连接' : '未连接'}`} />
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              后端未连接（先启动 server：cd server && npm start）
            </span>
          )}
          {running && (
            <span className="ml-auto flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
              {running}
            </span>
          )}
        </div>

        {/* ===== 页签：分段控件 ===== */}
        <nav className="seg mt-4" role="tablist">
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
              role="tab"
              aria-selected={tab === key}
              data-active={tab === key}
              onClick={() => setTab(key)}
              className="seg-item"
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
