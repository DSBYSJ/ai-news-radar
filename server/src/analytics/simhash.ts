import { textTokens } from './tokens.ts'

/**
 * 64 位 SimHash（零依赖纯 TS 实现）
 *
 * 原理：把每个 token 用 FNV-1a 64 位哈希映射为一个 64 维 ±1 向量（按权重加权），
 * 对所有 token 求和后取符号位 → 得到文本的 64 位指纹。
 * 两篇文档的相似度 = 1 - 汉明距离/64（局部敏感哈希：内容越接近，指纹越接近）。
 */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = (1n << 64n) - 1n

/** FNV-1a 64 位哈希（对 Unicode 码点逐个散列） */
export function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET
  for (const ch of text) {
    hash ^= BigInt(ch.codePointAt(0) ?? 0)
    hash = (hash * FNV_PRIME) & MASK64
  }
  return hash
}

const TITLE_WEIGHT = 3 // 标题命中比摘要命中更有信息量
const SUMMARY_WEIGHT = 1
const SUMMARY_CAP = 600 // 摘要只取前 600 字，防止长文淹没标题

/** 标题 + 摘要 → 加权 token 表 */
export function weightedTokens(title: string, summary: string): Map<string, number> {
  const weights = new Map<string, number>()
  for (const t of textTokens(title)) weights.set(t, (weights.get(t) ?? 0) + TITLE_WEIGHT)
  for (const t of textTokens(summary.slice(0, SUMMARY_CAP))) weights.set(t, (weights.get(t) ?? 0) + SUMMARY_WEIGHT)
  return weights
}

/** 计算 64 位 SimHash 指纹 */
export function simhash64(title: string, summary: string): bigint {
  const weights = weightedTokens(title, summary)
  const vector = new Array<number>(64).fill(0)

  for (const [token, weight] of weights) {
    const h = fnv1a64(token)
    for (let i = 0; i < 64; i++) {
      vector[i] += (h >> BigInt(i)) & 1n ? weight : -weight
    }
  }

  let out = 0n
  for (let i = 0; i < 64; i++) {
    if (vector[i] > 0) out |= 1n << BigInt(i)
  }
  return out
}

/** 汉明距离（不同二进制位的个数，0~64） */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    if (x & 1n) count += 1
    x >>= 1n
  }
  return count
}

/** SimHash 相似度 = 1 - 汉明距离 / 64（与需求阈值 0.75 同口径） */
export function simhashSimilarity(a: bigint, b: bigint): number {
  return 1 - hammingDistance(a, b) / 64
}
