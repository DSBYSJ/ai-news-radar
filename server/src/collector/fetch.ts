import { config } from '../config.ts'

export interface FetchResult {
  ok: boolean
  status: number | null
  body: string
  error?: string
  ms: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 抓取文本资源（RSS / Atom）。
 * - 超时默认 10s，失败重试 1 次，重试间隔 ≥1s（礼貌抓取）
 * - 跟随重定向（部分源需要，如 blog.google）
 * - 不绕反爬：用明确的 User-Agent 正常请求，被拦则记录失败并跳过
 */
export async function fetchText(url: string, opts: { timeoutMs?: number; retries?: number } = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const retries = opts.retries ?? 1

  let lastError = ''
  let lastStatus: number | null = null
  let lastMs = 0

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000)

    const startedAt = Date.now()
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': config.fetchUa,
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      lastMs = Date.now() - startedAt
      lastStatus = res.status

      if (!res.ok) {
        lastError = `HTTP ${res.status}`
        continue
      }
      return { ok: true, status: res.status, body: await res.text(), ms: lastMs }
    } catch (err) {
      lastMs = Date.now() - startedAt
      lastStatus = null
      lastError =
        err instanceof Error
          ? err.name === 'TimeoutError'
            ? `timeout(${timeoutMs}ms)`
            : `${err.name}: ${err.message}`
          : String(err)
    }
  }

  return { ok: false, status: lastStatus, body: '', error: lastError, ms: lastMs }
}
