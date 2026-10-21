import { colorOf, RISK_COLOR } from './riskColors.ts'

/**
 * 宏观-微观风险交叉矩阵（散点图）
 *
 * - X 轴 = 实体脆弱度（负面占比 + 热度退潮 + 缺融资的合成分）
 * - Y 轴 = 近期热度（提及量，归一化）
 * - 气泡大小 = 提及量；颜色 = 当前宏观压力（CRS）色带
 * - 右上角（高脆弱 + 高热度）= 自动飘红 / 发光
 *
 * ⚠️ 数据约束：库里没有"每个实体的宏观暴露度"（需要行业分类/市值数据），
 * 所以 X 轴用实体自身脆弱度、宏观压力用**整体背景色带**表达，而不是把 CRS 拆到每个点上。
 */

interface Bubble {
  entity: string
  score: number
  mentions: number
  negativeShare: number
  heatChange: number | null
  funding: number
}

interface Props {
  items: Bubble[]
  /** 当前宏观压力（CRS 分数），用于背景色带与图例 */
  macroPressure: number | null
  height?: number
}

const W = 660
const H = 260
const PAD_L = 38
const PAD_R = 14
const PAD_T = 16
const PAD_B = 34

export default function ScatterMatrix({ items, macroPressure, height = 260 }: Props) {
  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-[11px] text-slate-500">
        当前宏观压力不高（CRS &lt; 50），暂不生成交叉矩阵 —— 触发条件是 CRS ≥ 50
      </p>
    )
  }

  const innerW = W - PAD_L - PAD_R
  const innerH = height - PAD_T - PAD_B
  const maxMentions = Math.max(...items.map((i) => i.mentions), 1)
  const xOf = (score: number): number => PAD_L + (score / 100) * innerW
  const yOf = (mentions: number): number => PAD_T + innerH - (mentions / maxMentions) * innerH
  const rOf = (mentions: number): number => 6 + Math.sqrt(mentions / maxMentions) * 12

  const dangerZoneX = xOf(60)
  const dangerZoneY = yOf(maxMentions * 0.5)

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="宏观-微观风险交叉矩阵">
        {/* 网格 */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={xOf(v)} y1={PAD_T} x2={xOf(v)} y2={PAD_T + innerH} className="stroke-[var(--chart-grid)]" strokeWidth="1" />
            <text x={xOf(v)} y={PAD_T + innerH + 12} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 8.5 }}>
              {v}
            </text>
          </g>
        ))}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_L} y1={yOf(maxMentions * f)} x2={W - PAD_R} y2={yOf(maxMentions * f)} className="stroke-[var(--chart-grid)]" strokeWidth="1" />
            <text x={PAD_L - 5} y={yOf(maxMentions * f) + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 8.5 }}>
              {Math.round(maxMentions * f)}
            </text>
          </g>
        ))}

        {/* 右上危险区 */}
        <rect
          x={dangerZoneX}
          y={PAD_T}
          width={Math.max(0, PAD_L + innerW - dangerZoneX)}
          height={Math.max(0, dangerZoneY - PAD_T)}
          fill="rgba(229,72,77,0.07)"
          stroke="rgba(229,72,77,0.35)"
          strokeDasharray="4 3"
          strokeWidth="1"
        />
        <text x={PAD_L + innerW - 6} y={PAD_T + 12} textAnchor="end" className="fill-[#e5484d]" style={{ fontSize: 9 }}>
          高脆弱 × 高热度
        </text>

        {/* 气泡 */}
        {items.map((it) => {
          const x = xOf(it.score)
          const y = yOf(it.mentions)
          const r = rOf(it.mentions)
          const danger = it.score >= 60 && it.mentions >= maxMentions * 0.5
          const color = danger ? RISK_COLOR.critical : colorOf(macroPressure)
          return (
            <g key={it.entity}>
              <circle
                cx={x}
                cy={y}
                r={r}
                fill={`${color}33`}
                stroke={color}
                strokeWidth={danger ? 2 : 1.4}
                className={danger ? 'risk-breath' : ''}
                style={danger ? { filter: `drop-shadow(0 0 10px ${color}88)` } : undefined}
              />
              <text x={x} y={y + r + 10} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 8.5 }}>
                {it.entity.length > 10 ? `${it.entity.slice(0, 9)}…` : it.entity}
              </text>
              {/* tooltip */}
              <title>
                {it.entity}：脆弱度 {it.score}，提及 {it.mentions}，负面占比 {(it.negativeShare * 100).toFixed(0)}%，
                {it.heatChange === null ? '热度变化 —' : `热度 ${it.heatChange > 0 ? '+' : ''}${(it.heatChange * 100).toFixed(0)}%`}，
                融资 {it.funding}
              </title>
            </g>
          )
        })}

        {/* 轴标题 */}
        <text x={PAD_L + innerW / 2} y={height - 4} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 9 }}>
          实体脆弱度（负面占比 + 热度退潮 + 缺融资）
        </text>
        <text x={10} y={PAD_T + innerH / 2} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 9 }} transform={`rotate(-90 10 ${PAD_T + innerH / 2})`}>
          近期热度（提及量）
        </text>
      </svg>

      <p className="mt-1 text-[10px] text-slate-500">
        气泡大小 = 提及量；颜色 = 当前宏观压力（CRS
        {macroPressure !== null ? ` ${macroPressure}` : ' 未计算'}）色带。红色气泡 = 落在危险区。
      </p>
    </div>
  )
}
