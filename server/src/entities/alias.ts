import type { DatabaseSync } from 'node:sqlite'

/**
 * 实体别名与归一化（v0.24.0）
 *
 * 三条边界（对应需求里的硬约束）：
 *   1. **不改源数据**：`mentions` 表保持"模型抽出来的原文"，绝不回写
 *   2. **查询时归并**：聚合走 别名规则 → 底表映射 → 原文 三级解析，
 *      所以别名一保存立即生效，不依赖重算
 *   3. **异步重算只做产物**：`npm run realign:entities` 把对齐结果写进
 *      `entity_mapping`（供校准与溯源），并输出统计 —— 不阻塞接口
 *
 * 归一化启发式（在没有任何规则时也能合并最常见的写法差异）：
 *   大小写、空格、连字符、下划线、点号视为等价（"Open AI"/"openai"/"OpenAI" → 同一键）
 */

export interface AliasRule {
  alias: string
  canonical: string
  note: string | null
}

/** 启发式键：只用于"是否同一个东西"的判断，不作为展示名 */
export function entityKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\-_.·]+/g, '')
    .replace(/[（()）【】\[\]]/g, '')
}

/** 加载手工别名规则 */
export function loadAliasMap(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT alias, canonical FROM entity_aliases').all() as unknown as AliasRule[]
  return new Map(rows.map((r) => [r.alias.trim(), r.canonical.trim()]))
}

/** 加载异步任务产出的底表映射 */
export function loadMapping(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT raw, canonical FROM entity_mapping').all() as unknown as { raw: string; canonical: string }[]
  return new Map(rows.map((r) => [r.raw, r.canonical]))
}

/**
 * 把一个实体名解析成"标准名"。
 * 优先级：手工别名规则 > 底表映射（异步任务产物）> 原文
 */
export function canonicalEntity(
  name: string,
  aliasMap: Map<string, string>,
  mapping: Map<string, string>,
): string {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  return aliasMap.get(trimmed) ?? mapping.get(trimmed) ?? trimmed
}

/**
 * 归并一组实体名：同键的合并到同一标准名下。
 * 用于"实体热度榜"这类聚合场景。
 */
export function mergeEntities(
  names: string[],
  aliasMap: Map<string, string>,
  mapping: Map<string, string>,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of names) {
    const canonical = canonicalEntity(raw, aliasMap, mapping)
    if (!canonical) continue
    out.set(canonical, (out.get(canonical) ?? 0) + 1)
  }
  return out
}

/** 管理接口用的完整规则列表 */
export function listAliases(db: DatabaseSync): (AliasRule & { id: number; created_at: string })[] {
  return db
    .prepare('SELECT id, alias, canonical, note, created_at FROM entity_aliases ORDER BY id DESC')
    .all() as unknown as (AliasRule & { id: number; created_at: string })[]
}

/** 新增别名；已存在同名的规则则更新目标（幂等） */
export function upsertAlias(db: DatabaseSync, alias: string, canonical: string, note = ''): void {
  const now = new Date().toISOString()
  const a = alias.trim()
  const c = canonical.trim()
  if (!a || !c) throw new Error('别名与标准名都不能为空')
  if (entityKey(a) === entityKey(c)) throw new Error('别名与标准名归一化后相同，无需配置')
  db.prepare(
    `INSERT INTO entity_aliases (alias, canonical, note, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical, note = excluded.note`,
  ).run(a, c, note, now)
  // 规则一变，立即刷新底表映射里这一行，保证查询与校准视图一致
  db.prepare(
    `INSERT INTO entity_mapping (raw, canonical, source, updated_at) VALUES (?, ?, 'rule', ?)
     ON CONFLICT(raw) DO UPDATE SET canonical = excluded.canonical, source = 'rule', updated_at = excluded.updated_at`,
  ).run(a, c, now)
}

export function deleteAlias(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM entity_aliases WHERE id = ?').run(id)
}

/** 底表映射视图（item 13：原文 → 标准名） */
export function listMapping(
  db: DatabaseSync,
  opts: { limit?: number; q?: string } = {},
): { raw: string; canonical: string; source: string; updated_at: string; mentions: number }[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  const q = opts.q?.trim() ?? ''
  const like = `%${q.replace(/%/g, '')}%`
  const where = q ? 'WHERE m.raw LIKE ? OR m.canonical LIKE ?' : ''
  const params: (string | number)[] = q ? [like, like, limit] : [limit]
  return db
    .prepare(
      `SELECT m.raw, m.canonical, m.source, m.updated_at,
              (SELECT COUNT(*) FROM mentions x WHERE x.entity = m.raw) AS mentions
         FROM entity_mapping m
         ${where}
         ORDER BY mentions DESC, m.raw ASC
         LIMIT ?`,
    )
    .all(...params) as unknown as { raw: string; canonical: string; source: string; updated_at: string; mentions: number }[]
}
