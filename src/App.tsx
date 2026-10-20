import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api.ts'
import { applyRefraction, resetRefraction } from './utils/liquidGlass.ts'
import { useBurstFeed } from './hooks/useBurstFeed.ts'
import ListPage from './pages/ListPage.tsx'
import HotPage from './pages/HotPage.tsx'
import OverviewPage from './pages/OverviewPage.tsx'
import SummaryPage from './pages/SummaryPage.tsx'
import TrendPage from './pages/TrendPage.tsx'
import type { Health, SourceItem } from './types.ts'
import { CATEGORY_LABELS } from './utils/format.ts'

type Tab = 'overview' | 'list' | 'hot' | 'trend' | 'summary'
type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const saved = localStorage.getItem('theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function SunIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [health, setHealth] = useState<Health | null>(null)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [running, setRunning] = useState<string>('')
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])

  // 液态玻璃折射：按元素尺寸生成 SVG 位移贴图并挂到 backdrop-filter 上。
  // 只在深色模式生效（亮色模式保持原样）；内容变化 / 窗口尺寸变化后重扫。
  useEffect(() => {
    // 深色与亮色都做液态玻璃（两端玻璃的底色与参数不同，见 index.css / liquidGlass.ts）。
    // 切换主题时先清掉上一轮内联样式，避免上一模式的滤镜/参数残留。
    resetRefraction()
    let raf = 0
    const run = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => applyRefraction())
    }
    run()
    const mo = new MutationObserver(run)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', run)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('resize', run)
    }
  }, [theme, tab])

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

  // 首次挂载不播过渡（否则进页面会闪一下）
  const firstThemeRun = useRef(true)

  useEffect(() => {
    const root = document.documentElement
    if (!firstThemeRun.current) {
      // 切主题的瞬间挂 300ms 过渡类：背景/文字/边框颜色平滑过渡，结束后移除
      // —— 常驻 transition 会让长列表滚动与 SVG 重绘变卡。
      root.classList.add('theme-switching')
      // 强制回流：过渡类与颜色变化在同一帧发生时，浏览器会合并成"无过渡"
      void root.offsetHeight
    }
    root.classList.toggle('dark', theme === 'dark')
    firstThemeRun.current = false
    const timer = window.setTimeout(() => root.classList.remove('theme-switching'), 320)
    localStorage.setItem('theme', theme)

    // 安卓壳：状态栏图标颜色跟随站内主题（浏览器里没有插件，静默跳过）。
    // Capacitor 的命名习惯：style 'DARK' = 深色背景用浅色图标，'LIGHT' = 浅色背景用深色图标。
    const statusBar = (
      window as unknown as {
        Capacitor?: { Plugins?: { StatusBar?: { setStyle?: (o: { style: string }) => Promise<void> } } }
      }
    ).Capacitor?.Plugins?.StatusBar
    statusBar?.setStyle?.({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {})

    return () => window.clearTimeout(timer)
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
    'hover:border-slate-300 hover:text-slate-900 active:scale-90 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-400 dark:hover:border-white/25 dark:hover:text-white'

  // 安全区适配（安卓 App edge-to-edge 下避让状态栏与手势区；桌面端 env() 为 0，不受影响）
  return (
    <div className="mx-auto max-w-6xl overflow-x-hidden px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)] md:px-6 md:pt-[calc(env(safe-area-inset-top)+1.75rem)]">
      <header className="mb-6">
        {/* ===== 顶部：两层结构 =====
            第一层：品牌（字标 + 产品名 + 版本）+ 操作
            第二层：一句说明 + 数据读数（右侧）
            健康状态只在"异常时"出现 —— 三个常绿点占位但零信息量，是之前显乱的主因。
        */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* 字标：SONAR，O = 闭合环 + 实心点 + 外脉冲 */}
            <span
              className="flex select-none items-center text-slate-900 dark:text-white"
              aria-label="SONAR"
            >
              <span className="text-[22px] font-semibold uppercase leading-none tracking-[-0.03em]">S</span>
              <svg viewBox="0 0 24 24" className="mx-[0.01em] h-[19px] w-[19px]" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="8.1" stroke="var(--brand)" strokeWidth="2.3" />
                <circle cx="12" cy="12" r="2.5" fill="var(--brand)" />
                <path d="M17.6 6.4L21.6 2.4" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="text-[22px] font-semibold uppercase leading-none tracking-[-0.03em]">NAR</span>
            </span>

            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[var(--line)]" />

            <div className="flex min-w-0 items-baseline gap-1.5">
              <h1 className="truncate text-[13px] font-medium tracking-[-0.01em] text-slate-600 dark:text-slate-300">
                AI 资讯趋势雷达
              </h1>
              {health && (
                <span className="num shrink-0 text-[10.5px] text-slate-400 dark:text-slate-500" title="当前版本">
                  v{health.version}
                </span>
              )}
            </div>
          </div>

          {/* 操作区：主按钮实心 / 次按钮描边 / 主题为图标按钮 */}
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
              aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              className={btnIcon}
            >
              {/* 两个图标叠放：当前的转 0° 淡入，另一个转 -90° 缩 50% 淡出 */}
              <span className="relative block h-4 w-4">
                <SunIcon
                  className={`absolute inset-0 h-4 w-4 transition-all duration-500 ease-[cubic-bezier(0.22,0.68,0,1)] motion-reduce:transition-none ${
                    theme === 'dark' ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0'
                  }`}
                />
                <MoonIcon
                  className={`absolute inset-0 h-4 w-4 transition-all duration-500 ease-[cubic-bezier(0.22,0.68,0,1)] motion-reduce:transition-none ${
                    theme === 'dark' ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100'
                  }`}
                />
              </span>
            </button>
          </div>
        </div>

        {/* 第二层：说明 + 读数（读数在窄屏隐藏，避免挤成两行） */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 truncate text-[11.5px] text-slate-400 dark:text-slate-500">
            看的是「变化」：哪个方向在升温，哪些事件被多家独立源印证
          </p>

          {health ? (
            <p className="num hidden shrink-0 items-center gap-x-3 text-[11px] text-slate-400 sm:flex dark:text-slate-500">
              <span>{health.sources} 源</span>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
              <span>{health.rawItems.toLocaleString('en-US')} 原始</span>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
              <span>{(health.aiArticles ?? health.articles).toLocaleString('en-US')} 成品</span>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
              <span>{health.events.toLocaleString('en-US')} 事件</span>
              {health.latestDate && (
                <>
                  <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
                  <span
                    className={
                      health.latestDate === new Date().toISOString().slice(0, 10)
                        ? ''
                        : 'text-amber-600 dark:text-amber-400'
                    }
                    title="库内最新一条成品的日期（UTC）"
                  >
                    数据截至 {health.latestDate.slice(5)}
                  </span>
                </>
              )}
            </p>
          ) : (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              后端未连接（cd server && npm start）
            </p>
          )}
        </div>

        {/* 只在异常时出现：AI 未配置 / 鉴权未开 / 推送断开 / 正在跑任务 */}
        {((health && (!health.aiEnabled || !health.authEnabled)) || !connected || running !== '') && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {health && !health.aiEnabled && (
              <span className="text-amber-700 dark:text-amber-400">AI 未启用（走启发式兜底）</span>
            )}
            {health && !health.authEnabled && (
              <span className="text-amber-700 dark:text-amber-400">鉴权未开启</span>
            )}
            {!connected && <span className="text-amber-700 dark:text-amber-400">实时推送未连接</span>}
            {running && (
              <span className="flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-300">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
                {running}
              </span>
            )}
          </div>
        )}

        {/* ===== 页签：分段控件 ===== */}
        <nav className="seg mt-4" role="tablist">
          {(
            [
              ['overview', '概览'],
              ['hot', '热点'],
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

      {/* key={tab} 强制重挂载，切换页签时播放轻推入动画（.page-enter） */}
      <div key={tab} className="page-enter">
        {tab === 'overview' ? (
          <OverviewPage health={health} onNavigate={setTab} />
        ) : tab === 'hot' ? (
          <HotPage />
        ) : tab === 'list' ? (
          <ListPage sources={sources} />
        ) : tab === 'trend' ? (
          <TrendPage />
        ) : (
          <SummaryPage />
        )}
      </div>

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
