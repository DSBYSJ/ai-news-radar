import { chat } from './deepseek.ts'

/**
 * 自然语言 → SQL（Text-to-SQL）
 *
 * 安全设计（三层）：
 *  1. 提示词层面：只允许只读查询；
 *  2. 校验层面：白名单表名 + 禁用写操作关键字 + 强制 LIMIT + 拒绝多语句；
 *  3. 执行层面：**只读连接**（readOnly: true）——即使校验漏了也写不进库。
 *
 * 反编造：数字一律由 SQL 结果经确定性格式化产出，LLM 只允许写"解读"，
 * 且其数字必须全部能在结果里找到，否则整段解读丢弃（见 stripNarrative）。
 */

/** 允许查询的表（白名单，防幻觉表名） */
export const ALLOWED_TABLES = new Set([
  'articles',
  'raw_items',
  'sources',
  'mentions',
  'events',
  'event_clusters',
  'burst_detection',
  'daily_summaries',
])

/** 注入给模型的表结构说明（紧凑版，省 token） */
export const SCHEMA_HINT = `articles(id, raw_id, url, title, tldr, summary, category, entities, score, sentiment, event_key, published_at, created_at)
  · published_at 为 UTC ISO 字符串；日期用 date(published_at) 取 UTC 日期
  · category 固定枚举：model_release 模型发布 / product_update 产品更新 / research_paper 研究论文 / open_source 开源项目 / funding 融资 / policy 政策监管 / opinion 观点评论 / other 其他
  · sentiment：positive 正面 / neutral 中性 / negative 负面（可能为 NULL，未判定）
  · score 重要性 0~100；title / tldr / summary 为文本，模糊匹配用 LIKE '%kw%'
raw_items(id, source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
sources(id, name, url, kind, weight, enabled, last_fetch_at, last_status)
mentions(article_id, entity)  -- 实体提及，entity 已规范化（如 OpenAI、NVIDIA）
events(event_key, first_seen, last_seen, source_count, article_count, title_repr, category)
event_clusters(event_id, publish_date, representative_title, source_count, article_count, sources_list, category)
burst_detection(date, category, article_count, baseline_mean, baseline_std, z_score)  -- 突发检测，category 可能为 'all'（全站）
daily_summaries(date, title, content, highlights, stats, model, created_at, updated_at)`

const FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'replace', 'truncate',
  'attach', 'detach', 'pragma', 'vacuum', 'grant', 'revoke', 'reindex', 'begin', 'commit', 'rollback',
]

export function buildStatsPrompt(question: string): string {
  return `你是 SQLite 查询生成器。把用户问题翻译成**一条**只读 SELECT 查询。

【表结构】
${SCHEMA_HINT}

【要求】
1. 只输出 SQL 本体，不要解释、不要 markdown 代码块；
2. 必须带 LIMIT（<= 50）；要 Top N 就 ORDER BY ... DESC；
3. 需要来源名时：JOIN raw_items r ON r.id = a.raw_id JOIN sources s ON s.id = r.source_id；
4. 「最近 N 天 / 本周」用 date(published_at) >= date('now', '-N days')（库内是 UTC）；
5. 模糊匹配用 LIKE，实体用 mentions.entity = 'OpenAI'（按库内写法，注意大小写）；
6. 严禁任何写操作；聚合尽量给出可读别名（如 AS 篇数）。

【问题】
${question}

SQL:`
}

/** 从模型输出里抠出 SQL（去掉围栏、多余文字） */
export function extractSql(raw: string): string {
  const text = raw.trim()
  const fence = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : text
  const firstLine = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('--')) ?? ''
  return firstLine.replace(/;\s*$/, '').trim()
}

export interface SqlValidation {
  ok: boolean
  sql: string
  reason?: string
}

/**
 * SQL 安全校验：只读 + 白名单表 + 单语句 + 强制 LIMIT
 */
export function validateSql(input: string): SqlValidation {
  const sql = input.trim().replace(/;\s*$/, '').trim()
  if (!sql) return { ok: false, sql: '', reason: 'SQL 为空' }

  const lower = sql.toLowerCase()

  // 1) 只允许 SELECT / WITH 开头
  if (!/^(select|with)\b/.test(lower)) return { ok: false, sql: '', reason: '只允许 SELECT / WITH 开头的只读查询' }

  // 2) 禁止写操作关键字（按整词匹配，避免误伤 description 等字段名）
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) return { ok: false, sql: '', reason: `包含被禁止的关键字：${kw}` }
  }

  // 3) 单语句（去掉字符串字面量后不应再出现分号）
  const withoutStrings = sql.replace(/'[^']*'/g, "''")
  if (withoutStrings.includes(';')) return { ok: false, sql: '', reason: '只允许一条语句' }

  // 4) 表名白名单（FROM / JOIN 后的标识符；CTE 名字放行）
  const ctes = new Set([...lower.matchAll(/\bwith\s+([a-z_][a-z0-9_]*)\s+as\s*\(/g)].map((m) => m[1]))
  for (const m of lower.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g)) {
    const table = m[1]
    if (!ALLOWED_TABLES.has(table) && !ctes.has(table)) {
      return { ok: false, sql: '', reason: `不允许查询表：${table}` }
    }
  }

  // 5) 强制 LIMIT（防止模型生成全表扫描类查询）
  const limited = /\blimit\s+\d+/i.test(sql) ? sql : `${sql} LIMIT 50`
  return { ok: true, sql: limited }
}

/** 把结果确定性地格式化成答案（数字只来自这里，不经模型） */
export function formatRowsAsAnswer(rows: Record<string, unknown>[], question: string): string {
  if (rows.length === 0) return `库里没有符合「${question}」的记录。`

  const columns = Object.keys(rows[0])
  if (rows.length === 1 && columns.length === 1) {
    return `**${String(rows[0][columns[0]])}**（按「${question}」查询，共 1 条结果）`
  }

  const head = `| ${columns.join(' | ')} |`
  const sep = `|${columns.map(() => '---').join('|')}|`
  const body = rows
    .slice(0, 10)
    .map((r) => `| ${columns.map((c) => String(r[c] ?? '')).join(' | ')} |`)
    .join('\n')
  const more = rows.length > 10 ? `\n\n（仅显示前 10 行，共 ${rows.length} 行）` : ''
  return `按「${question}」查到 **${rows.length}** 行：\n\n${head}\n${sep}\n${body}${more}`
}

/** 抽取文本里的数字（归一化：去千分位与末尾 .0） */
export function numbersIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    out.push(m.replace(/[,]/g, '').replace(/\.0+$/, ''))
  }
  return out
}

/**
 * 反编造闸门：模型解读里若出现结果集中不存在的数字 → 整段丢弃（返回 null）
 */
export function stripNarrative(narrative: string, rows: Record<string, unknown>[]): string | null {
  const allowed = new Set<string>()
  for (const row of rows) {
    for (const v of Object.values(row)) {
      if (v === null || v === undefined) continue
      allowed.add(String(v).replace(/[,]/g, '').replace(/\.0+$/, ''))
      for (const n of numbersIn(String(v))) allowed.add(n)
    }
  }
  for (const n of numbersIn(narrative)) {
    if (!allowed.has(n)) return null
  }
  return narrative.trim() || null
}

/** 调模型生成 SQL（失败返回 null） */
export async function generateSql(question: string): Promise<string | null> {
  // json:false —— 生成的是 SQL 自由文本，不能用 json_object 模式
  const res = await chat(buildStatsPrompt(question), { maxTokens: 400, json: false })
  if (!res.ok) return null
  return extractSql(res.content)
}