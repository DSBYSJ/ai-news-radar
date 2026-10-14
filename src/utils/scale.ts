export function linearScale(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain
  const [r0, r1] = range
  if (d1 === d0) return () => r0
  return (v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)
}

/** 取整的刻度值（0 / max/4 / ... / max 附近的好看数字） */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
  const out: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(4)))
  if (out[out.length - 1] < max) out.push(Number((out[out.length - 1] + step).toFixed(4)))
  return out
}

export interface Point {
  x: number
  y: number
}

export function linePath(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
}

/** 面积图路径：上边界 + 回到基线（用于堆叠面积） */
export function areaPath(points: Point[], baselineY: number): string {
  if (points.length === 0) return ''
  const first = points[0]
  const last = points[points.length - 1]
  const top = linePath(points)
  return `${top} L${last.x.toFixed(2)},${baselineY.toFixed(2)} L${first.x.toFixed(2)},${baselineY.toFixed(2)} Z`
}
