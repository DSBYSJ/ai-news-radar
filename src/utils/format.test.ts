import { describe, expect, it } from 'vitest'
import { formatDateTime, formatPct, scoreColor, shortDate } from './format.ts'

describe('formatDateTime', () => {
  it('把 UTC ISO 转成本地可读格式（长度与分隔符正确）', () => {
    const text = formatDateTime('2026-10-13T18:43:15.976Z')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('非法输入原样返回，不抛错', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })
})

describe('shortDate', () => {
  it('截取 MM-DD', () => {
    expect(shortDate('2026-10-13')).toBe('10-13')
  })
})

describe('formatPct', () => {
  it('保留一位小数', () => {
    expect(formatPct(0.1234)).toBe('12.3%')
    expect(formatPct(1)).toBe('100.0%')
  })
})

describe('scoreColor', () => {
  it('高分偏红、中分偏橙、低分灰', () => {
    expect(scoreColor(90)).toBe('#dc2626')
    expect(scoreColor(50)).toBe('#d97706')
    expect(scoreColor(10)).toBe('#9ca3af')
    expect(scoreColor(null)).toBe('#9ca3af')
  })
})
