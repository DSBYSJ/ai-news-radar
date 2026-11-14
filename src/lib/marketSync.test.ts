import { describe, expect, it } from 'vitest'
import { marketSyncMessage } from './marketSync.ts'

describe('行情同步结果', () => {
  it('如实显示部分覆盖，不声称行情已最新', () => {
    const message = marketSyncMessage({
      prices: { symbols: 2, rows: 10, skipped: [{ symbol: 'TEST', reason: 'not covered' }] },
      ratios: { symbols: 2, rows: 0, skipped: [{ symbol: 'ONE', reason: 'unavailable' }, { symbol: 'TWO', reason: 'unavailable' }] },
    })
    expect(message).toContain('行情 1/2')
    expect(message).toContain('比率 0/2')
    expect(message).not.toContain('已是最新')
  })
})
