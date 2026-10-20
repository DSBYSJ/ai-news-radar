import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { AiStatusDebug, AliasRule, CollectDebug, MappingRow } from '../types.ts'

/**
 * 后台/调试页（v0.24.0）
 * 四个区块：实体别名管理 / 实体底表映射 / 采集健康度 / AI 处理状态
 * 仅本人使用（站点本身有登录拦截），不对外暴露入口之外的能力。
 */

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`
}

function ms(v: number | null): string {
  return v === null ? '—' : `${v} ms`
}

export default function SettingsPage() {
  const [aliases, setAliases] = useState<AliasRule[]>([])
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [mappingQ, setMappingQ] = useState('')
  const [alias, setAlias] = useState('')
  const [canonical, setCanonical] = useState('')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState('')
  const [collect, setCollect] = useState<CollectDebug | null>(null)
  const [ai, setAi] = useState<AiStatusDebug | null>(null)
  const [job, setJob] = useState<{ id: string; status: string; report?: unknown } | null>(null)

  const refreshAliases = useCallback(async () => {
    const r = await api.aliasList()
    setAliases(r.items)
  }, [])

  const refreshMapping = useCallback(async (q = '') => {
    const r = await api.entityMapping(q, 100)
    setMapping(r.items)
  }, [])

  useEffect(() => {
    void refreshAliases()
    void refreshMapping()
    void api.collectDebug(7).then(setCollect).catch(() => {})
    void api.aiStatus(14).then(setAi).catch(() => {})
  }, [refreshAliases, refreshMapping])

  const saveAlias = async (): Promise<void> => {
    if (!alias.trim() || !canonical.trim()) {
      setMsg('别名与标准名都要填')
      return
    }
    const r = await api.aliasSave(alias.trim(), canonical.trim(), note.trim())
    if (!r.ok) {
      setMsg(r.error ?? '保存失败')
      return
    }
    setMsg(`已保存：${alias.trim()} → ${canonical.trim()}（立即生效）`)
    setAlias('')
    setCanonical('')
    setNote('')
    await refreshAliases()
    await refreshMapping(mappingQ)
  }

  const removeAlias = async (id: number): Promise<void> => {
    await api.aliasDelete(id)
    setMsg('已删除，该别名恢复按原文统计')
    await refreshAliases()
  }

  const runRealign = async (): Promise<void> => {
    setMsg('重算任务已提交（后台运行，不阻塞页面）…')
    const r = await api.realignStart()
    if (!r.ok || !r.jobId) {
      setMsg('提交失败')
      return
    }
    setJob({ id: r.jobId, status: 'running' })
    // 轮询任务状态（语料小，通常 1 秒内完成）
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 400))
      const st = await api.realignStatus(r.jobId)
      setJob({ id: r.jobId, status: st.status, report: st.report })
      if (st.status !== 'running') break
    }
    await refreshMapping(mappingQ)
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">后台与调试</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          实体别名、底表映射、采集健康度、AI 处理状态 —— 全部只读现有数据，改动即时生效。
        </p>
      </header>

      {msg && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:bg-white/[0.04] dark:text-slate-300">
          {msg}
        </p>
      )}

      {/* ===== 实体别名管理 ===== */}
      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">实体别名合并</p>
          <button
            type="button"
            onClick={() => void runRealign()}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:opacity-90"
          >
            触发异步重算
          </button>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
          把不同叫法绑到同一个标准名上（如 <b>Open AI → OpenAI</b>）。保存后**立即生效**；
          重算任务只在后台把自动对齐结果写进底表映射，不改 <code className="num">mentions</code> 原文。
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-slate-400">别名（原文写法）</span>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Open AI"
              className="w-40 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[12.5px] dark:bg-white/[0.04]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-slate-400">标准名</span>
            <input
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              placeholder="OpenAI"
              className="w-40 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[12.5px] dark:bg-white/[0.04]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-slate-400">备注（可选）</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="大小写/空格差异"
              className="w-44 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[12.5px] dark:bg-white/[0.04]"
            />
          </label>
          <button
            type="button"
            onClick={() => void saveAlias()}
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12px] text-slate-700 transition hover:border-slate-400 dark:text-slate-200"
          >
            保存规则
          </button>
        </div>

        {aliases.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-white/[0.06]">
            {aliases.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-2 text-[12.5px]">
                <span className="text-slate-500 dark:text-slate-400">{r.alias}</span>
                <span aria-hidden="true" className="text-slate-300">→</span>
                <span className="font-medium text-slate-800 dark:text-slate-100">{r.canonical}</span>
                {r.note && <span className="truncate text-[11px] text-slate-400">（{r.note}）</span>}
                <button
                  type="button"
                  onClick={() => void removeAlias(r.id)}
                  className="ml-auto shrink-0 text-[11px] text-slate-400 hover:text-red-600"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}

        {job && (
          <p className="mt-2 text-[11px] text-slate-400">
            重算任务 {job.id}：{job.status === 'done' ? '已完成' : job.status === 'error' ? '失败' : '进行中…'}
            {job.status === 'done' && job.report ? '（结果见下方映射表）' : ''}
          </p>
        )}
      </section>

      {/* ===== 实体底表映射（item 13） ===== */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">实体底表映射</p>
          <input
            value={mappingQ}
            onChange={(e) => void refreshMapping(e.target.value)}
            placeholder="搜索原文或标准名…"
            className="w-52 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1 text-[11.5px] dark:bg-white/[0.04]"
          />
        </div>
        <p className="mt-1 text-[11.5px] text-slate-500 dark:text-slate-400">
          「模型抽出的原文」→「系统归并后的标准名」，用于校准归一化是否合理。
        </p>
        {mapping.length === 0 ? (
          <p className="mt-3 text-[12px] text-slate-400">
            还没有映射记录 —— 点上面的「触发异步重算」生成，或先保存一条别名规则。
          </p>
        ) : (
          <div className="mt-3 max-h-72 overflow-y-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 bg-white text-[10.5px] text-slate-400 dark:bg-[#141821]">
                <tr>
                  <th className="py-1.5 font-medium">原文</th>
                  <th className="py-1.5 font-medium">标准名</th>
                  <th className="py-1.5 font-medium">来源</th>
                  <th className="py-1.5 text-right font-medium">提及</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                {mapping.map((m) => (
                  <tr key={m.raw}>
                    <td className="py-1.5 text-slate-600 dark:text-slate-300">{m.raw}</td>
                    <td className="py-1.5 font-medium text-slate-800 dark:text-slate-100">{m.canonical}</td>
                    <td className="py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          m.source === 'rule'
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400'
                        }`}
                      >
                        {m.source === 'rule' ? '手工' : '自动'}
                      </span>
                    </td>
                    <td className="num py-1.5 text-right text-slate-500">{m.mentions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ===== 采集健康度（item 11） ===== */}
      <section className="card p-4">
        <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">采集健康度（近 7 天）</p>
        {!collect ? (
          <p className="mt-2 text-[12px] text-slate-400">加载中…</p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[12px]">
                <thead className="text-[10.5px] text-slate-400">
                  <tr>
                    <th className="py-1.5 font-medium">源</th>
                    <th className="py-1.5 font-medium">成功率</th>
                    <th className="py-1.5 font-medium">轮次</th>
                    <th className="py-1.5 font-medium">平均耗时</th>
                    <th className="py-1.5 font-medium">最长</th>
                    <th className="py-1.5 font-medium">最近一次</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                  {collect.perSource.map((s) => (
                    <tr key={s.id}>
                      <td className="py-1.5 font-medium text-slate-800 dark:text-slate-100">
                        {s.name}
                        {s.failStreak > 0 && (
                          <span className="num ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                            连续失败 {s.failStreak}
                          </span>
                        )}
                      </td>
                      <td className="num py-1.5">
                        <span className={s.successRate !== null && s.successRate < 0.9 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300'}>
                          {pct(s.successRate)}
                        </span>
                      </td>
                      <td className="num py-1.5 text-slate-500">{s.runs}</td>
                      <td className="num py-1.5 text-slate-500">{ms(s.avgMs)}</td>
                      <td className="num py-1.5 text-slate-500">{ms(s.maxMs)}</td>
                      <td className="num py-1.5 text-slate-500">{s.lastAt ? s.lastAt.slice(5, 16).replace('T', ' ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {collect.daily.length > 0 && (
              <div className="mt-3">
                <p className="text-[10.5px] text-slate-400">每日抓取量 / 失败量</p>
                <div className="mt-1.5 flex items-end gap-1.5">
                  {collect.daily.map((d) => {
                    const max = Math.max(...collect.daily.map((x) => x.runs), 1)
                    return (
                      <div key={d.d} className="flex flex-1 flex-col items-center gap-1" title={`${d.d}：${d.runs} 轮，失败 ${d.fails}`}>
                        <div className="flex w-full items-end gap-0.5" style={{ height: 48 }}>
                          <div
                            className="flex-1 rounded-t bg-[var(--accent)]"
                            style={{ height: `${Math.max(2, (d.runs / max) * 48)}px`, opacity: 0.85 }}
                          />
                          <div
                            className="flex-1 rounded-t bg-red-500"
                            style={{ height: `${Math.max(2, (d.fails / max) * 48)}px` }}
                          />
                        </div>
                        <span className="num text-[9px] text-slate-400">{d.d.slice(5)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {collect.errors.length > 0 && (
              <div className="mt-3">
                <p className="text-[10.5px] text-slate-400">最近错误（{collect.errors.length}）</p>
                <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-slate-50 p-2 font-mono text-[10.5px] leading-relaxed text-slate-500 dark:bg-black/20 dark:text-slate-400">
                  {collect.errors.map((e, i) => (
                    <li key={i}>
                      {e.at.slice(5, 16).replace('T', ' ')}　{e.source_id}　{e.error ?? '未知错误'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* ===== AI 处理状态（item 12） ===== */}
      <section className="card p-4">
        <p className="eyebrow text-[10px] text-slate-400 dark:text-slate-500">AI 处理状态（近 14 天）</p>
        {!ai ? (
          <p className="mt-2 text-[12px] text-slate-400">加载中…</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-3 text-[11.5px] text-slate-500 dark:text-slate-400">
              <span>
                <span className="num font-semibold text-slate-800 dark:text-slate-100">
                  {ai.byDay.reduce((s, d) => s + Number(d.ok), 0)}
                </span>{' '}
                正常
              </span>
              <span>
                <span className="num font-semibold text-red-600 dark:text-red-400">
                  {ai.byDay.reduce((s, d) => s + Number(d.failed), 0)}
                </span>{' '}
                失败
              </span>
              <span>
                <span className="num font-semibold text-amber-600 dark:text-amber-400">
                  {ai.byDay.reduce((s, d) => s + Number(d.timeout), 0)}
                </span>{' '}
                超时
              </span>
              <span>
                <span className="num font-semibold text-slate-500">
                  {ai.byDay.reduce((s, d) => s + Number(d.heuristic), 0)}
                </span>{' '}
                启发式兜底
              </span>
            </div>
            {ai.recent.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-100 dark:divide-white/[0.06]">
                {ai.recent.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 py-1.5 text-[11.5px]">
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                        r.ai_status === 'ok'
                          ? 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400'
                          : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                      }`}
                    >
                      {r.ai_status}
                    </span>
                    <span className="truncate text-slate-600 dark:text-slate-300">{r.title}</span>
                    <span className="num ml-auto shrink-0 text-slate-400">{r.source_name}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10.5px] leading-relaxed text-slate-400">
              说明：`ai_status` 在 v0.24.0 才引入，历史条目为空时按「正常」计；
              单条/批量重跑加工请到服务器执行 <code className="num">npm run process</code>（或指定日期范围）。
            </p>
          </>
        )}
      </section>
    </div>
  )
}
