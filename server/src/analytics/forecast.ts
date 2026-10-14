import type { DatabaseSync } from 'node:sqlite'
import { dailyVolume } from './trend.ts'

/**
 * 短期热度预测（7 天）
 *
 * 方法：Holt 线性趋势 + 阻尼（damped trend exponential smoothing）。
 * - 相比 ARIMA/Prophet 无需外库、对 30 天量级的稀疏序列更稳；
 * - 阻尼系数 φ<1 让预测越远越平（避免线性趋势外推得离谱）；
 * - 置信带 = 点预测 ± 1.6 × 训练残差标准差（并截断到 ≥0）。
 *
 * 行文里明确：这是「统计外推」，不是因果预言；数据稀疏时带宽会很大，要照实展示。
 */

const DAY_MS = 86_400_000

export interface ForecastPoint {
  date: string
  value: number
  lo: number
  hi: number
}

export interface ForecastResult {
  history: { date: string; value: number }[]
  forecast: ForecastPoint[]
  summary: {
    changePct: number | null
    direction: 'up' | 'down' | 'flat'
    message: string
  }
}

export interface HoltResult {
  point: number[]
  lo: number[]
  hi: number[]
}

/** 纯函数：Holt 阻尼线性趋势（便于单测） */
export function holtForecast(
  values: number[],
  horizon: number,
  opts: { alpha?: number; beta?: number; phi?: number; z?: number } = {},
): HoltResult {
  const alpha = opts.alpha ?? 0.35
  const beta = opts.beta ?? 0.12
  const phi = opts.phi ?? 0.9
  const z = opts.z ?? 1.6

  if (values.length === 0) {
    return { point: Array(horizon).fill(0), lo: Array(horizon).fill(0), hi: Array(horizon).fill(0) }
  }

  let level = values[0]
  let trend = values.length > 1 ? values[1] - values[0] : 0
  const residuals: number[] = []

  for (let i = 1; i < values.length; i++) {
    const phiTrend = phi * trend
    const pred = level + phiTrend
    residuals.push(values[i] - pred)
    const prevLevel = level
    level = alpha * values[i] + (1 - alpha) * pred
    trend = beta * (level - prevLevel) + (1 - beta) * phiTrend
  }

  const point: number[] = []
  const dampedFactor = phi < 1 ? (1 - phi) : 1
  for (let h = 1; h <= horizon; h++) {
    const sum = phi < 1 ? (phi * (1 - Math.pow(phi, h))) / dampedFactor : h * phi
    point.push(Math.max(0, level + sum * trend))
  }

  const n = residuals.length
  const mean = n > 0 ? residuals.reduce((a, b) => a + b, 0) / n : 0
  const sd = n > 1 ? Math.sqrt(residuals.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (n - 1)) : 0
  const width = z * sd

  return {
    point,
    lo: point.map((p) => Math.max(0, p - width)),
    hi: point.map((p) => p + width),
  }
}

export function forecastVolume(db: DatabaseSync, days = 30, horizon = 7): ForecastResult {
  const series = dailyVolume(db, days)
  const values = series.map((p) => p.value)
  const { point, lo, hi } = holtForecast(values, horizon)

  const lastDate = series.length > 0 ? Date.parse(`${series[series.length - 1].date}T00:00:00Z`) : Date.now()
  const forecast: ForecastPoint[] = point.map((v, i) => ({
    date: new Date(lastDate + (i + 1) * DAY_MS).toISOString().slice(0, 10),
    value: Number(v.toFixed(1)),
    lo: Number(lo[i].toFixed(1)),
    hi: Number(hi[i].toFixed(1)),
  }))

  const recent = values.slice(-7)
  const recentAvg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0
  const forecastAvg = point.length > 0 ? point.reduce((a, b) => a + b, 0) / point.length : 0
  const changePct = recentAvg > 0 ? Number((((forecastAvg - recentAvg) / recentAvg) * 100).toFixed(1)) : null

  const direction: 'up' | 'down' | 'flat' =
    changePct === null ? 'flat' : changePct >= 8 ? 'up' : changePct <= -8 ? 'down' : 'flat'

  const message =
    direction === 'up'
      ? `未来一周热度可能继续升温（预计 +${Math.abs(changePct ?? 0)}%）`
      : direction === 'down'
        ? `未来一周热度可能回落（预计 ${changePct}%）`
        : '未来一周预计总体平稳'

  return {
    history: series.map((p) => ({ date: p.date, value: p.value })),
    forecast,
    summary: { changePct, direction, message },
  }
}
