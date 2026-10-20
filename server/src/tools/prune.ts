/**
 * 存储清理（自用站点的"定期清理"）
 *
 * 现状：本项目**不存正文**，只存标题 + 摘要 + 原文链接 + AI 生成的短摘要，
 *      所以体积很小（约 3,300 条成品 / 4,500 条原始 ≈ 16 MB）。
 * 这个脚本用于长期运行后按需瘦身：
 *   npx tsx src/tools/prune.ts --days=180 --dry-run   # 先看会删多少
 *   npx tsx src/tools/prune.ts --days=180 --vacuum     # 真删并回收空间
 *
 * 删除的是「成品 + 原始条目」这一对（articles 依赖 raw_items，不能只删一边），
 * 事件聚合（events / event_clusters）与简报（daily_summaries）保留——
 * 它们只含标题与计数，体积小，且是趋势历史的依据。
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

interface Args {
  days: number
  dryRun: boolean
  vacuum: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${flag}=`))
    return hit ? hit.slice(flag.length + 3) : undefined
  }
  return {
    days: Math.max(7, Number(get('days') ?? 180)),
    dryRun: argv.includes('--dry-run'),
    vacuum: argv.includes('--vacuum'),
  }
}

function dbPath(): string {
  return process.env.DB_PATH ?? path.join(import.meta.dirname, '../../data/ai-news.db')
}

function sizeMb(file: string): number {
  try {
    return Math.round((statSync(file).size / 1024 / 1024) * 10) / 10
  } catch {
    return 0
  }
}

const { days, dryRun, vacuum } = parseArgs(process.argv.slice(2))
const file = dbPath()
const before = sizeMb(file)
const db = new DatabaseSync(file)

const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
const cutoffDate = cutoff.slice(0, 10)

const articles = Number(
  (db.prepare('SELECT COUNT(*) AS n FROM articles WHERE date(published_at) < ?').get(cutoffDate) as { n: number }).n,
)
const raws = Number(
  (db.prepare('SELECT COUNT(*) AS n FROM raw_items WHERE date(published_at) < ?').get(cutoffDate) as { n: number }).n,
)

console.log(`数据库：${file}`)
console.log(`当前体积：${before} MB`)
console.log(`保留最近 ${days} 天（早于 ${cutoffDate} 的将被清理）`)
console.log(`将删除：成品 ${articles} 条、原始 ${raws} 条`)

if (articles === 0 && raws === 0) {
  console.log('没有需要清理的数据。')
  db.close()
  process.exit(0)
}

if (dryRun) {
  console.log('（--dry-run：只看不删。去掉该参数并加 --vacuum 才会真正执行）')
  db.close()
  process.exit(0)
}

// 一个事务里删干净：向量 → 成品 → 原始（顺序不能反，外键依赖）
const run = db.prepare('DELETE FROM article_vectors WHERE article_id IN (SELECT id FROM articles WHERE date(published_at) < ?)')
const delArticles = db.prepare('DELETE FROM articles WHERE date(published_at) < ?')
const delRaws = db.prepare(`DELETE FROM raw_items WHERE date(published_at) < ? AND id NOT IN (SELECT raw_id FROM articles)`)

db.exec('BEGIN')
try {
  const vec = run.run(cutoffDate).changes
  const art = delArticles.run(cutoffDate).changes
  const raw = delRaws.run(cutoffDate).changes
  db.exec('COMMIT')
  console.log(`已删除：向量 ${Number(vec)}、成品 ${Number(art)}、原始 ${Number(raw)}`)
} catch (err) {
  db.exec('ROLLBACK')
  console.error('清理失败，已回滚：', err)
  db.close()
  process.exit(1)
}

if (vacuum) {
  console.log('正在 VACUUM 回收空间（大库会花一点时间）…')
  db.exec('VACUUM')
}

const after = sizeMb(file)
console.log(`清理后体积：${after} MB（${before >= after ? '-' : '+'}${Math.abs(Math.round((before - after) * 10) / 10)} MB）`)
console.log('提示：日报/周报只依赖聚合结果，清理历史成品不影响当前版面；趋势图会少掉被删日期的点。')
db.close()
