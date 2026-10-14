import { createHash } from 'node:crypto'

/** 常见追踪参数（URL 归一化时剥离） */
const TRACKING_KEYS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid'])

/** URL 归一化：剥离 utm_* 等追踪参数、去掉 fragment */
export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    u.hash = ''
    const params = new URLSearchParams()
    for (const [k, v] of u.searchParams) {
      const key = k.toLowerCase()
      if (key.startsWith('utm_') || TRACKING_KEYS.has(key)) continue
      params.append(k, v)
    }
    const qs = params.toString()
    u.search = qs ? `?${qs}` : ''
    return u.toString()
  } catch {
    return rawUrl.trim()
  }
}

/** 标题噪声词（指纹计算时剔除） */
const NOISE_WORDS = new Set([
  '发布',
  '推出',
  '宣布',
  '上线',
  '正式',
  'announcing',
  'announce',
  'announced',
  'announcement',
  'launch',
  'launches',
  'launched',
  'introducing',
  'introduces',
  'new',
  'now',
])

/**
 * 标题指纹（去重第一道关，成本为零）：
 * NFKC 归一（兼容全角）→ 小写 → 去标点/符号 → 去噪声词 → 排序 token → sha1
 * 只用于「完全同名」级别的廉价去重；相似度去重（编辑距离 / SimHash）放到第二阶段。
 */
export function titleFingerprint(title: string): string {
  const tokens = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NOISE_WORDS.has(t))
    .sort()
  return createHash('sha1').update(tokens.join(' ')).digest('hex')
}
