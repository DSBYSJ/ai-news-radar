import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_PARAMS, type RiskParams } from './calculation.ts'

/**
 * 风险参数存取（v0.26.0）
 *
 * - 参数存 `risk_params` 表（key='default'），后台可改
 * - 读取时与默认值**深合并**：老参数文件缺字段时用默认值补齐（向后兼容）
 * - 参数变化 → 需要跑一次异步重算（`npm run risk:backfill`）才会体现在历史曲线上
 */

const KEY = 'default'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 深合并：params 覆盖 defaults，缺失的用默认值 */
export function mergeParams(defaults: RiskParams, patch: unknown): RiskParams {
  if (!isPlainObject(patch)) return defaults
  const out: Record<string, unknown> = { ...defaults }
  for (const [k, v] of Object.entries(patch)) {
    const base = (defaults as unknown as Record<string, unknown>)[k]
    if (isPlainObject(base) && isPlainObject(v)) {
      out[k] = mergeParams(base as never, v) as never
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as unknown as RiskParams
}

export function loadParams(db: DatabaseSync): RiskParams {
  try {
    const row = db.prepare('SELECT params FROM risk_params WHERE key = ?').get(KEY) as { params: string } | undefined
    if (!row) return DEFAULT_PARAMS
    return mergeParams(DEFAULT_PARAMS, JSON.parse(row.params))
  } catch {
    return DEFAULT_PARAMS
  }
}

export function saveParams(db: DatabaseSync, patch: unknown): RiskParams {
  const merged = mergeParams(DEFAULT_PARAMS, patch)
  db.prepare(
    `INSERT INTO risk_params (key, params, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET params = excluded.params, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(merged), new Date().toISOString())
  return merged
}

export function resetParams(db: DatabaseSync): RiskParams {
  db.prepare('DELETE FROM risk_params WHERE key = ?').run(KEY)
  return DEFAULT_PARAMS
}

/** 校验：权重合计是否接近 100，超出直接拒绝（避免算出来的分没有意义） */
export function validateParams(p: RiskParams): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const nfiSum = Object.values(p.nfi).reduce((a, b) => a + b, 0)
  if (Math.abs(nfiSum - 100) > 0.5) errors.push(`NFI 权重合计 ${nfiSum.toFixed(1)}，应为 100`)
  const crsSum = Object.values(p.crs).reduce((a, b) => a + b, 0)
  if (Math.abs(crsSum - 100) > 0.5) errors.push(`CRS 权重合计 ${crsSum.toFixed(1)}，应为 100`)
  for (const [k, v] of Object.entries(p.steps)) {
    if (!Number.isFinite(v)) errors.push(`阶跃阈值 ${k} 不是有效数字`)
  }
  if (p.probability.base <= 0 || p.probability.base > 1) errors.push('概率基础率必须在 (0,1]')
  if (p.probability.scale <= 0) errors.push('概率 scale 必须为正')
  return { ok: errors.length === 0, errors }
}
