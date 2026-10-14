import { XMLParser } from 'fast-xml-parser'

export interface FeedItem {
  guid: string
  url: string
  title: string
  summary: string
  publishedAt: Date | null
}

export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'rdf'
  items: FeedItem[]
}

type XmlNode = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // 保留实体（&amp; 等）不预解码 —— 先剥离 HTML 标签，再统一解码实体，
  // 避免「纯文本里恰好含尖括号」被误当成标签吃掉
  processEntities: false,
})

const MAX_SUMMARY_LENGTH = 1500
const MAX_TITLE_LENGTH = 500

/** 常见命名字符实体（数值实体另行处理） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  trade: '™',
  middot: '·',
  laquo: '«',
  raquo: '»',
}

function decodeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 剥离 HTML 标签 + 解码字符实体（顺序：先剥标签，再解码） */
export function stripHtml(input: string): string {
  if (!input) return ''
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => decodeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => decodeCodePoint(Number(d)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return text(value[0])
  if (typeof value === 'object') {
    const t = (value as XmlNode)['#text']
    if (t !== undefined) return text(t)
  }
  return ''
}

/** 提取链接：RSS 为纯文本，Atom 为带 href/rel 的属性节点（优先 rel="alternate"） */
function extractLink(raw: XmlNode): string {
  const linkVal = raw.link
  if (typeof linkVal === 'string' || typeof linkVal === 'number') return String(linkVal)

  const links = asArray(linkVal)
  const nodes = links.filter((l): l is XmlNode => typeof l === 'object' && l !== null)
  const alternate = nodes.find((n) => text(n['@_rel']) === 'alternate' && text(n['@_href']))
  const withHref = alternate ?? nodes.find((n) => text(n['@_href']))
  if (withHref) return text(withHref['@_href'])

  return text(links[0])
}

function extractGuid(raw: XmlNode, fallback: string): string {
  return text(raw.guid) || text(raw.id) || fallback
}

/** 时间取解析后的 Date（绝不用原始字符串比较，见 docs/项目方案.md 第七节「实现级坑」） */
function extractDate(raw: XmlNode): Date | null {
  for (const candidate of [raw.pubDate, raw.published, raw.updated, raw['dc:date']]) {
    const s = text(candidate)
    if (!s) continue
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function mapItem(raw: XmlNode): FeedItem | null {
  const title = truncate(stripHtml(text(raw.title)), MAX_TITLE_LENGTH)
  if (!title) return null

  const url = extractLink(raw).trim()
  const rawSummary = [raw.description, raw.summary, raw['content:encoded'], raw.content]
    .map((v) => text(v))
    .find((s) => s.trim().length > 0)

  return {
    title,
    url,
    guid: extractGuid(raw, url || title),
    summary: rawSummary ? truncate(stripHtml(rawSummary), MAX_SUMMARY_LENGTH) : '',
    publishedAt: extractDate(raw),
  }
}

function mapItems(raw: unknown): FeedItem[] {
  return asArray(raw)
    .map((it) => (typeof it === 'object' && it !== null ? mapItem(it as XmlNode) : null))
    .filter((x): x is FeedItem => x !== null)
}

/**
 * 解析 RSS 2.0 / Atom / RSS 1.0 (RDF) 为统一条目结构。
 * - 格式无法识别或 XML 损坏 → 抛错（由采集器记为单源失败，不中断整轮）
 * - 格式合法但 0 条 → 正常返回（如 arXiv 周末为空，勿误判为故障）
 */
export function parseFeed(xml: string): ParsedFeed {
  let root: unknown
  try {
    root = parser.parse(xml)
  } catch (err) {
    throw new Error(`XML 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof root !== 'object' || root === null) {
    throw new Error('XML 解析失败：文档为空')
  }

  const doc = root as XmlNode

  if (doc.html !== undefined) {
    throw new Error('返回的是 HTML 页面而非 feed（可能被拦截，检查 UA 与源地址）')
  }

  const rss = doc.rss as XmlNode | undefined
  if (rss) {
    const channel = (rss.channel ?? {}) as XmlNode
    return { kind: 'rss', items: mapItems(channel.item) }
  }

  const feed = doc.feed as XmlNode | undefined
  if (feed) {
    return { kind: 'atom', items: mapItems(feed.entry) }
  }

  const rdf = doc['rdf:RDF'] as XmlNode | undefined
  if (rdf) {
    return { kind: 'rdf', items: mapItems(rdf.item) }
  }

  throw new Error('无法识别的 feed 格式（既非 RSS 也非 Atom）')
}
