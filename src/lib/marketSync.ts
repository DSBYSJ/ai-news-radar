export interface MarketSyncReport {
  prices: { symbols: number; rows: number; skipped: { symbol: string; reason: string }[] }
  ratios: { symbols: number; rows: number; skipped: { symbol: string; reason: string }[] }
}

/** 同步完成不代表全部覆盖，也不代表上游已提供最新交易日。 */
export function marketSyncMessage(report?: MarketSyncReport): string {
  if (!report) return '同步结束，请查看行情日期与覆盖范围'
  const count = (part: MarketSyncReport['prices']) => Math.max(0, part.symbols - part.skipped.length)
  return `同步结束：行情 ${count(report.prices)}/${report.prices.symbols}，比率 ${count(report.ratios)}/${report.ratios.symbols}；请查看行情日期`
}
