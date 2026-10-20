import type { DatabaseSync } from 'node:sqlite'
import { loadAliasMap, loadMapping, entityKey, canonicalEntity } from './alias.ts'

/**
 * 实体归一化重算（异步任务）
 *
 *   cd server && npm run realign:entities            # 干跑，只输出会怎么合并
 *   cd server && npm run realign:entities -- --apply # 写入 entity_mapping
 *
 * 做什么：
 *   1. 扫全部 mentions（**只读，不改源数据**），按 entityKey 分组
 *   2. 每组选出标准名：有手工别名规则 → 用规则目标；否则取组内**出现次数最多**的写法
 *      （并列时取更短的那个，"OpenAI" 比 "Open AI " 更可能被采用）
 *   3. 结果写入 entity_mapping（source 标记 rule / auto）
 *
 * 不做什么：
 *   - 不回写 mentions / articles（原文始终可追溯）
 *   - 不在这里做聚合查询：查询侧每次都走「别名规则 → 底表映射 → 原文」三级解析，
 *     所以这个任务只是把自动对齐结果**沉淀**下来供校准与溯源，不跑也不影响正确性
 */

interface Row {
  entity: string
  n: number
}

export interface RealignReport {
  scanned: number
  distinctRaw: number
  distinctCanonical: number
  mergedGroups: number
  ruleHits: number
  autoHits: number
  samples: { canonical: string; from: string[] }[]
}

export function realign(db: DatabaseSync, opts: { apply?: boolean } = {}): RealignReport {
  const rows = db.prepare('SELECT entity, COUNT(*) AS n FROM mentions GROUP BY entity').all() as unknown as Row[]
  const aliasMap = loadAliasMap(db)

  // 按 key 分组
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const name = r.entity.trim()
    if (!name) continue
    const key = entityKey(name)
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  const now = new Date().toISOString()
  const insert = db.prepare(
    `INSERT INTO entity_mapping (raw, canonical, source, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(raw) DO UPDATE SET canonical = excluded.canonical, source = excluded.source, updated_at = excluded.updated_at`,
  )

  let mergedGroups = 0
  let ruleHits = 0
  let autoHits = 0
  const samples: { canonical: string; from: string[] }[] = []

  if (opts.apply) db.exec('BEGIN')
  try {
    for (const list of groups.values()) {
      if (list.length === 0) continue
      // 选标准名：先看组内有没有成员的键命中手工别名规则
      let canonical: string | null = null
      let viaRule = false
      for (const r of list) {
        const rule = aliasMap.get(r.entity.trim())
        if (rule) {
          canonical = rule
          viaRule = true
          break
        }
      }
      if (!canonical) {
        // 取出现次数最多的写法；并列取更短（更像标准写法）
        canonical = [...list].sort((a, b) => Number(b.n) - Number(a.n) || a.entity.length - b.entity.length)[0].entity.trim()
      }

      const changed = list.length > 1 || list.some((r) => r.entity.trim() !== canonical)
      if (changed) {
        mergedGroups += 1
        if (viaRule) ruleHits += 1
        else autoHits += 1
        if (samples.length < 12) {
          samples.push({ canonical, from: list.map((r) => `${r.entity.trim()}(${r.n})`) })
        }
      }
      if (opts.apply) {
        for (const r of list) {
          insert.run(r.entity.trim(), canonical, viaRule ? 'rule' : 'auto', now)
        }
      }
    }
    if (opts.apply) db.exec('COMMIT')
  } catch (err) {
    if (opts.apply) db.exec('ROLLBACK')
    throw err
  }

  const distinctRaw = rows.length
  const distinctCanonical = groups.size
  return {
    scanned: rows.reduce((s, r) => s + Number(r.n), 0),
    distinctRaw,
    distinctCanonical,
    mergedGroups,
    ruleHits,
    autoHits,
    samples,
  }
}

/** 查询侧小工具：把 (entity, 指标) 行按标准名归并 */
export function aggregateByCanonical<T extends { entity: string }>(
  db: DatabaseSync,
  rows: T[],
  value: (row: T) => number,
): Map<string, number> {
  const aliasMap = loadAliasMap(db)
  const mapping = loadMapping(db)
  const out = new Map<string, number>()
  for (const row of rows) {
    const c = canonicalEntity(row.entity, aliasMap, mapping)
    if (!c) continue
    out.set(c, (out.get(c) ?? 0) + value(row))
  }
  return out
}
