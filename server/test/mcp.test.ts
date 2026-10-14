import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'

/** MCP stdio 服务器冒烟测试：握手 → tools/list → tools/call */
test('MCP stdio：initialize / tools/list / tools/call 全链路', async () => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/mcp/stdio.ts')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const lines: string[] = []
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) lines.push(line.trim())
    }
  })

  const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`)

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_bursts', arguments: { days: 30 } } })

  const deadline = Date.now() + 15_000
  while (lines.length < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  child.kill()

  const parsed = lines.map((l) => JSON.parse(l) as { id?: number; result?: Record<string, unknown> })
  const init = parsed.find((p) => p.id === 1)
  assert.equal((init?.result as { serverInfo?: { name?: string } })?.serverInfo?.name, 'ai-news-radar')

  const list = parsed.find((p) => p.id === 2)
  const tools = (list?.result as { tools?: unknown[] })?.tools ?? []
  assert.ok(tools.length >= 5, `工具数 ${tools.length} 应 ≥ 5`)

  const call = parsed.find((p) => p.id === 3)
  const content = (call?.result as { content?: { type: string; text: string }[] })?.content ?? []
  assert.equal(content[0]?.type, 'text')
  assert.ok(typeof content[0]?.text === 'string' && content[0].text.length > 0)
})
