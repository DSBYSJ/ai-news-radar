import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFeed, stripHtml } from '../src/collector/parse.ts'

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>示例频道</title>
    <item>
      <title>OpenAI 发布 GPT-5</title>
      <link>https://example.com/a</link>
      <guid isPermaLink="false">post-1</guid>
      <description><![CDATA[<p>正文 <b>加粗</b> &amp; 实体</p>]]></description>
      <pubDate>Tue, 13 Oct 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>第二条</title>
      <link>https://example.com/b?utm_source=rss</link>
      <description>Hello &lt;world&gt;</description>
    </item>
  </channel>
</rss>`

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>示例 Atom</title>
  <entry>
    <title>Atom 条目一</title>
    <link rel="alternate" type="text/html" href="https://example.com/atom-1"/>
    <id>tag:example.com,2026:1</id>
    <updated>2026-10-12T10:30:00Z</updated>
    <summary>一段摘要 &amp; 说明</summary>
  </entry>
</feed>`

test('parseFeed：RSS 2.0 字段解析正确（guid / 时间转 Date / 摘要剥标签）', () => {
  const feed = parseFeed(RSS_SAMPLE)
  assert.equal(feed.kind, 'rss')
  assert.equal(feed.items.length, 2)

  const first = feed.items[0]
  assert.equal(first.title, 'OpenAI 发布 GPT-5')
  assert.equal(first.guid, 'post-1')
  assert.equal(first.url, 'https://example.com/a')
  assert.equal(first.summary, '正文 加粗 & 实体')
  assert.equal(first.publishedAt?.toISOString(), '2026-10-13T08:00:00.000Z')

  // 无 guid 时回退到 link；无 pubDate 时 publishedAt 为 null（由落库层兜底为抓取时间）
  const second = feed.items[1]
  assert.equal(second.guid, 'https://example.com/b?utm_source=rss')
  assert.equal(second.publishedAt, null)
})

test('parseFeed：Atom 解析（link 取 rel=alternate、时间取 updated）', () => {
  const feed = parseFeed(ATOM_SAMPLE)
  assert.equal(feed.kind, 'atom')
  assert.equal(feed.items.length, 1)

  const item = feed.items[0]
  assert.equal(item.url, 'https://example.com/atom-1')
  assert.equal(item.guid, 'tag:example.com,2026:1')
  assert.equal(item.publishedAt?.toISOString(), '2026-10-12T10:30:00.000Z')
  assert.equal(item.summary, '一段摘要 & 说明')
})

test('parseFeed：无标题条目被跳过（title 是 NOT NULL）', () => {
  const feed = parseFeed('<rss version="2.0"><channel><item><link>https://example.com/x</link></item></channel></rss>')
  assert.equal(feed.items.length, 0)
})

test('parseFeed：HTML 页面直接抛错（防把拦截页当 feed）', () => {
  assert.throws(() => parseFeed('<html><body>blocked</body></html>'), /HTML/)
})

test('stripHtml：先剥标签再解实体，纯文本里的尖括号不被误吃', () => {
  assert.equal(stripHtml('<p>A &amp; B</p>'), 'A & B')
  assert.equal(stripHtml('Hello &lt;world&gt;'), 'Hello <world>')
  assert.equal(stripHtml('分数 &#x4E2D; &#25991;'), '分数 中 文')
})

test('parseFeed：有 content:encoded 时抽出正文（≥600 字才保留，剥掉标签）', async () => {
  const { parseFeed } = await import('../src/collector/parse.ts')
  const body = '这是一段很长的正文。'.repeat(120) // ~1200 字
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>t</title>
    <item>
      <title>有全文的条目</title>
      <link>https://example.com/a</link>
      <description>一句话摘要</description>
      <content:encoded><![CDATA[<p>${body}</p><script>alert(1)</script>]]></content:encoded>
      <pubDate>Mon, 20 Oct 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>只有摘要的条目</title>
      <link>https://example.com/b</link>
      <description>短摘要</description>
      <pubDate>Mon, 20 Oct 2026 09:00:00 GMT</pubDate>
    </item>
  </channel></rss>`
  const feed = parseFeed(xml)
  assert.equal(feed.items.length, 2)
  const withContent = feed.items[0]
  assert.ok(withContent.content && withContent.content.length > 600, '应抽出正文')
  assert.ok(!withContent.content.includes('<script>'), '正文必须剥掉标签')
  assert.ok(withContent.summary.length < 60, '摘要仍只取简短的那句')
  assert.equal(feed.items[1].content, undefined, '只有摘要时不存正文')
})

test('htmlToText：块级标签转成换行，段落得以保留（不再是一堵墙）', async () => {
  const { htmlToText } = await import('../src/collector/parse.ts')
  const html = '<div><p>第一段内容。</p><p>第二段：<strong>加粗</strong>与<br>换行</p><p>第三段。</p><script>alert(1)</script></div>'
  const text = htmlToText(html)
  assert.ok(!text.includes('<'), '不应残留标签')
  assert.ok(!text.includes('alert'), '脚本应被移除')
  const paras = text.split(/\n{2,}/).filter(Boolean)
  assert.equal(paras.length, 3, `应按段落切成 3 段，实际 ${paras.length}：${JSON.stringify(paras)}`)
  assert.equal(paras[0], '第一段内容。')
  assert.ok(paras[1].includes('加粗') && paras[1].includes('换行'))
  assert.equal(paras[2], '第三段。')
})

test('htmlToText：stripHtml 仍是单行（标题/摘要不能被换行污染）', async () => {
  const { stripHtml, htmlToText } = await import('../src/collector/parse.ts')
  const html = '<p>标题一</p><p>标题二</p>'
  assert.ok(!stripHtml(html).includes('\n'), 'stripHtml 应压成单行')
  assert.ok(htmlToText(html).includes('\n'), 'htmlToText 应保留换行')
})

test('htmlToText：转义过的 HTML（IT之家式 &lt;p&gt;）也要清干净', async () => {
  const { htmlToText } = await import('../src/collector/parse.ts')
  const escaped = '&lt;p data-vmark="1612"&gt;第一段&lt;/p&gt;&lt;p&gt;第二段&lt;/p&gt;'
  const text = htmlToText(escaped)
  assert.ok(!text.includes('<p'), '不应残留 HTML 标签')
  assert.ok(!text.includes('&lt;'), '不应残留转义实体')
  const paras = text.split(/\n{2,}/).filter(Boolean)
  assert.equal(paras.length, 2, `应切成 2 段，实际 ${JSON.stringify(paras)}`)
})
