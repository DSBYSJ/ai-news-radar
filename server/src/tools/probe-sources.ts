/**
 * 候选 RSS 源探测（一次性脚本，不入库、不写库）
 *
 *   node src/tools/probe-sources.ts
 *
 * 目的：加源之前先验证「能不能取到、能取到多少、最新一条是什么时候」。
 * 项目约定「宁可少而稳」：时通时不通的源比源数量变化更难处理，一律不接。
 */
import { fetchText } from '../collector/fetch.ts'
import { parseFeed } from '../collector/parse.ts'

interface Candidate {
  id: string
  name: string
  url: string
  /** 分类：给判断用，不影响探测 */
  tag: '中文科技' | '中文财经' | '英文 AI' | '英文创投' | '机构/研究'
}

const CANDIDATES: Candidate[] = [
  // ---------- 中文：财经/创投（补「估值叙事」缺口） ----------
  { id: '36kr', name: '36氪', url: 'https://36kr.com/feed', tag: '中文财经' },
  { id: 'huxiu', name: '虎嗅', url: 'https://www.huxiu.com/rss/0.xml', tag: '中文财经' },
  { id: 'tmtpost', name: '钛媒体', url: 'https://www.tmtpost.com/rss.xml', tag: '中文财经' },
  { id: 'jiemian', name: '界面新闻', url: 'https://a.jiemian.com/index.php?m=article&a=rss', tag: '中文财经' },
  { id: 'pingwest', name: '品玩', url: 'https://www.pingwest.com/feed', tag: '中文财经' },
  // ---------- 中文：科技 ----------
  { id: 'jiqizhixin', name: '机器之心', url: 'https://www.jiqizhixin.com/rss', tag: '中文科技' },
  { id: 'sspai', name: '少数派', url: 'https://sspai.com/feed', tag: '中文科技' },
  { id: 'sina-tech', name: '新浪科技', url: 'https://rss.sina.com.cn/tech/rollnews.xml', tag: '中文科技' },
  // ---------- 英文：创投/融资 ----------
  { id: 'crunchbase-news', name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/', tag: '英文创投' },
  { id: 'tc-venture', name: 'TechCrunch Venture', url: 'https://techcrunch.com/category/venture/feed/', tag: '英文创投' },
  { id: 'vb-ai', name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', tag: '英文 AI' },
  // ---------- 英文：AI 一手/研究 ----------
  { id: 'hf-blog', name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', tag: '英文 AI' },
  { id: 'deepmind', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', tag: '机构/研究' },
  { id: 'meta-ai', name: 'Meta AI Blog', url: 'https://ai.meta.com/blog/rss/', tag: '机构/研究' },
  { id: 'stanford-hai', name: 'Stanford HAI', url: 'https://hai.stanford.edu/news/rss.xml', tag: '机构/研究' },
  { id: 'ieee-ai', name: 'IEEE Spectrum AI', url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss', tag: '机构/研究' },
  { id: 'the-batch', name: 'The Batch (DeepLearning.AI)', url: 'https://www.deeplearning.ai/the-batch/feed/', tag: '英文 AI' },
  { id: 'import-ai', name: 'Import AI', url: 'https://importai.substack.com/feed', tag: '英文 AI' },
  { id: 'semianalysis', name: 'SemiAnalysis', url: 'https://semianalysis.com/feed/', tag: '机构/研究' },
  { id: 'wired-ai', name: 'Wired AI', url: 'https://www.wired.com/feed/tag/ai/latest/rss', tag: '英文 AI' },
]

interface Result {
  c: Candidate
  ok: boolean
  status: number | string | null
  items: number
  latest: string
  note: string
}

async function probe(c: Candidate): Promise<Result> {
  try {
    const r = await fetchText(c.url, { timeoutMs: 12_000, retries: 0 })
    const feed = parseFeed(r.body)
    const items = feed.items ?? []
    if (items.length === 0) {
      return { c, ok: false, status: r.status ?? "ERR", items: 0, latest: "—", note: "解析出 0 条" }
    }
    const dates = items
      .map((i) => i.publishedAt?.toISOString().slice(0, 10) ?? '')
      .filter(Boolean)
      .sort()
    return {
      c,
      ok: true,
      status: r.status ?? "ERR",
      items: items.length,
      latest: dates[dates.length - 1] ?? '无日期',
      note: '',
    }
  } catch (e) {
    return { c, ok: false, status: 'ERR', items: 0, latest: '—', note: String(e).slice(0, 60) }
  }
}

const results = await Promise.all(CANDIDATES.map(probe))
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)))

console.log('\n源名'.padEnd(26) + '分类      状态  条数  最新        备注')
console.log('-'.repeat(96))
for (const r of results) {
  console.log(
    pad(r.c.name, 24) +
      pad(r.c.tag, 10) +
      String(r.status).padEnd(6) +
      String(r.items).padEnd(6) +
      pad(r.latest, 12) +
      r.note,
  )
}
const ok = results.filter((r) => r.ok)
console.log(`\n可用 ${ok.length}/${results.length}　不可用 ${results.length - ok.length}`)
