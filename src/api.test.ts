import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api.ts'

afterEach(() => vi.unstubAllGlobals())

it('风险重算将选定的时间范围传给服务端', async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true, jobId: 'test' }))
  vi.stubGlobal('fetch', fetch)
  await api.riskRecompute(90)
  expect(fetch).toHaveBeenCalledWith('/api/news/risk/recompute?days=90', expect.objectContaining({ method: 'POST' }))
})
