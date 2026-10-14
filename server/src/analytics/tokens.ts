/** 标题 token 化：英文按词，中文按字 bigram（中文无空格，整串当 token 无法算相似度） */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be',
  'new', 'now', 'at', 'by', 'from', 'as', 'its', 'it', 'this', 'that', 'will', 'can',
  '发布', '推出', '上线', '宣布', '正式',
])

const WORD_RE = /[a-z0-9]+|[\u4e00-\u9fff]+/g

/** 通用文本 token 化（标题、摘要、SimHash 共用） */
export function textTokens(input: string): string[] {
  const text = input.normalize('NFKC').toLowerCase()
  const out: string[] = []

  for (const m of text.match(WORD_RE) ?? []) {
    if (/^[a-z0-9]+$/.test(m)) {
      if (m.length >= 2 && !STOP_WORDS.has(m)) out.push(m)
      continue
    }
    // 中文片段：长度 1 单独成 token，否则取字 bigram
    if (m.length === 1) {
      if (!STOP_WORDS.has(m)) out.push(m)
    } else {
      for (let i = 0; i < m.length - 1; i++) out.push(m.slice(i, i + 2))
    }
  }

  return [...new Set(out)]
}

/** 标题 token（语义同 textTokens，保留旧名给既有调用方） */
export function titleTokens(title: string): string[] {
  return textTokens(title)
}

/** Jaccard 相似度（0~1） */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}
