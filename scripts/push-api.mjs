/**
 * 通过 GitHub Git Data API 推送（本机到 github.com:443 的 TLS 不通，只有 api.github.com 可用）。
 *
 *   node scripts/push-api.mjs --token=gho_xxx --message="提交信息" --files=a,b,c
 *
 * 做法：读远程 main 的 tree → 把本地文件作为 blob 叠上去 → 建 commit → 移动 ref。
 * 不改写远程历史，只在最新提交之上追加一次提交。
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = new Map()
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/s.exec(a)
  if (m) args.set(m[1], m[2])
}
const token = args.get('token')
const message = args.get('message')
const branch = args.get('branch') ?? 'main'
if (!token || !message) {
  console.error('用法：node scripts/push-api.mjs --token=... --message="..." [--branch=main]')
  process.exit(1)
}

const API = 'https://api.github.com'
const REPO = args.get('repo') ?? 'DSBYSJ/ai-news-radar'

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}

/** 相对上一次远程提交改动的文件（本地 HEAD 与其父提交的差集） */
function changedFiles() {
  const out = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

const files = args.get('files') ? args.get('files').split(',').map((s) => s.trim()) : changedFiles()
if (files.length === 0) {
  console.log('没有改动，退出')
  process.exit(0)
}

const ref = await gh('GET', `/repos/${REPO}/git/ref/heads/${branch}`)
const parentSha = ref.object.sha
const parent = await gh('GET', `/repos/${REPO}/git/commits/${parentSha}`)
const baseTree = parent.tree.sha
console.log(`远程 ${branch} = ${parentSha.slice(0, 7)}（tree ${baseTree.slice(0, 7)}）`)
console.log(`本地待推送 ${files.length} 个文件`)

const tree = []
for (const path of files) {
  const content = readFileSync(path)
  const blob = await gh('POST', `/repos/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${path} → ${blob.sha.slice(0, 7)}`)
}

const newTree = await gh('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree })
const commit = await gh('POST', `/repos/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [parentSha],
})
await gh('PATCH', `/repos/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
console.log(`\n✅ 已推送 ${commit.sha.slice(0, 7)} → ${REPO}@${branch}`)
