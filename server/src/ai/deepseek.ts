import { config } from '../config.ts'

export interface ChatResult {
  ok: boolean
  content: string
  error?: string
}

/**
 * DeepSeek 对话接口（仅用于内部加工，不对外提供任何对话式服务）。
 * - 未配置 Key 时直接返回失败 → 由调用方走启发式兜底，绝不丢数据
 * - 超时由 DEEPSEEK_TIMEOUT_MS 控制，默认 20s
 */
export async function chat(
  prompt: string,
  opts: { maxTokens?: number; temperature?: number; retries?: number } = {},
): Promise<ChatResult> {
  if (!config.deepseek.apiKey) {
    return { ok: false, content: '', error: 'DEEPSEEK_API_KEY 未配置' }
  }

  const body = {
    model: config.deepseek.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 2048,
    response_format: { type: 'json_object' },
  }

  let lastError = ''
  const retries = opts.retries ?? 1

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.deepseek.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.deepseek.timeoutMs),
      })

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200)
        lastError = `HTTP ${res.status} ${detail}`
        continue
      }

      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const content = json.choices?.[0]?.message?.content?.trim() ?? ''
      if (!content) {
        lastError = '返回内容为空'
        continue
      }
      return { ok: true, content }
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
  }

  return { ok: false, content: '', error: lastError }
}
