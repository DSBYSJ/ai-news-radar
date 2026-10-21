import { useEffect, useRef, useState } from 'react'

/**
 * 数字滚动（CountUp）
 *
 * 纯 JS 实现（不引第三方库）：easeOutExpo 缓动 + requestAnimationFrame，
 * 首次挂载时从 0 滚到目标值；值变化时从旧值滚到新值。
 * 支持 `prefers-reduced-motion` 时直接跳到终值。
 */

interface Props {
  value: number | null | undefined
  /** 小数位 */
  decimals?: number
  /** 时长 ms */
  duration?: number
  className?: string
  /** 无数据时显示的占位 */
  placeholder?: string
}

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - 2 ** (-10 * t)
}

export default function CountUp({ value, decimals = 0, duration = 900, className = '', placeholder = '—' }: Props) {
  const [display, setDisplay] = useState<number | null>(null)
  const fromRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      setDisplay(null)
      return
    }
    const from = fromRef.current
    const to = value
    if (from === to) {
      setDisplay(to)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = to
      setDisplay(to)
      return
    }
    const start = performance.now()
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      const v = from + (to - from) * easeOutExpo(t)
      setDisplay(v)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = to
        setDisplay(to)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [value, duration])

  return (
    <span className={`num ${className}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {display === null ? placeholder : display.toFixed(decimals)}
    </span>
  )
}
