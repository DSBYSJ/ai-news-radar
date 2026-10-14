import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import ListPage from './pages/ListPage.tsx'
import SummaryPage from './pages/SummaryPage.tsx'
import TrendPage from './pages/TrendPage.tsx'
import type { Health, SourceItem } from './types.ts'

type Tab = 'list' | 'trend' | 'summary'

export default function App() {
  const [tab, setTab] = useState<Tab>('list')
  const [health, setHealth] = useState<Health | null>(null)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [running, setRunning] = useState<string>('')

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

  return (
    <div className="mx-auto max-w-5xl p-4">
      <header className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">AI 资讯趋势雷达</h1>
            <p className="text-xs text-slate-500">
              不是资讯阅读器 —— 看的是「变化」：哪个方向在升温，哪些事件被多家独立源印证
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void run('collect')}
              disabled={running !== ''}
              className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
            >
              采集
            </button>
            <button
              type="button"
              onClick={() => void run('process')}
              disabled={running !== ''}
              className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
            >
              加工
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {health ? (
            <>
              <span className="rounded bg-slate-100 px-2 py-0.5">v{health.version}</span>
              <span className="rounded bg-slate-100 px-2 py-0.5">源 {health.sources}</span>
              <span className="rounded bg-slate-100 px-2 py-0.5">原始 {health.rawItems}</span>
              <span className="rounded bg-slate-100 px-2 py-0.5">成品 {health.articles}</span>
              <span className="rounded bg-slate-100 px-2 py-0.5">事件 {health.events}</span>
              <span className={`rounded px-2 py-0.5 ${health.aiEnabled ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                AI {health.aiEnabled ? '已启用' : '未配置（启发式兜底）'}
              </span>
              <span className={`rounded px-2 py-0.5 ${health.authEnabled ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                鉴权 {health.authEnabled ? '已开启' : '未开启（本地）'}
              </span>
            </>
          ) : (
            <span>后端未连接（先启动 server：cd server && npm start）</span>
          )}
          {running && <span className="text-slate-600">{running}</span>}
        </div>

        <nav className="mt-3 flex gap-1 border-b border-slate-200">
          {(
            [
              ['list', '资讯列表'],
              ['trend', '趋势分析'],
              ['summary', '每日总结'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === key ? 'border-slate-900 font-medium text-slate-900' : 'border-transparent text-slate-500'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'list' ? <ListPage sources={sources} /> : tab === 'trend' ? <TrendPage /> : <SummaryPage />}
    </div>
  )
}
