#!/usr/bin/env node
/**
 * 推送前敏感信息审计（pre-push 闸门）
 *
 * 目的：服务器相关信息（IP / 域名 / 备案号 / 宝塔路径 / 密钥）绝不出现在公开仓库。
 * 检查范围是「本次真正要推送的那些提交」，而不是工作区 —— 因为工作区干净、
 * 历史里有毒，照样会泄。
 *
 * 用法：
 *   1) 由 .githooks/pre-push 自动调用（git push 时读 stdin）
 *   2) 手动检查某个区间：node scripts/pre-push-audit.mjs --range origin/main..HEAD
 *   3) 检查暂存区：      node scripts/pre-push-audit.mjs --staged
 *
 * 本文件会被提交到公开仓库，因此**不得包含任何真值**：
 * 域名、IP、备案号等只写在 scripts/audit-words.local（已在 .gitignore 内）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ZERO = /^0+$/

/** 内置规则：只放「形态」，不放真值 */
const RULES = [
  {
    id: 'public-ip',
    desc: '公网 IP 地址',
    // 先粗匹配四段点分数字，再在回调里排除内网/回环
    test: (line) => {
      const hits = line.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []
      return hits.filter((ip) => {
        const [a, b] = ip.split('.').map(Number)
        if (a === 127 || a === 10 || a === 0) return false
        if (a === 192 && b === 168) return false
        if (a === 172 && b >= 16 && b <= 31) return false
        if (a === 255 || a > 255) return false
        return true
      })
    },
  },
  { id: 'bt-panel-path', desc: '宝塔 / 服务器目录路径', test: (l) => l.match(/\/www\/(wwwroot|server|wwwlogs)/g) },
  { id: 'api-key', desc: '疑似 API Key', test: (l) => l.match(/\bsk-[A-Za-z0-9_-]{16,}/g) },
  { id: 'private-key', desc: '私钥内容', test: (l) => l.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g) },
  { id: 'icp-number', desc: '真实备案号', test: (l) => l.match(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼]ICP备\s?\d{4,}/g) },
  { id: 'ssh-fingerprint', desc: 'SSH 公钥指纹', test: (l) => l.match(/SHA256:[A-Za-z0-9+/]{40,}/g) },
]

/** 禁止被推送的路径（内部文档 / 密钥 / 运维脚本） */
const FORBIDDEN_PATHS = [
  { re: /^docs\//, desc: '内部文档目录 docs/' },
  { re: /^启动提示词\.md$/, desc: '内部启动提示词' },
  { re: /^server\/\.env(\..+)?$/, desc: '后端环境变量（含密钥）' },
  { re: /^server\/scripts\//, desc: '运维脚本目录' },
  { re: /^server\/README\.md$/, desc: '服务器说明' },
  { re: /(^|\/)\.env\.local$/, desc: '本地环境变量' },
  { re: /\.(pem|p12|pfx|key)$/i, desc: '证书/私钥文件' },
  { re: /(^|\/)id_(ed25519|rsa)(_deploy)?$/, desc: 'SSH 私钥' },
  { re: /^scripts\/audit-words\.local$/, desc: '审计词表（含真值）' },
]

/** 外部词表：每行一个真值（域名 / 主机名 / 内网标识），# 开头为注释 */
function loadLocalWords() {
  const p = resolve(ROOT, 'scripts/audit-words.local')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

function git(args, input) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    input,
  })
}

/** 只保留可疑片段，避免把整行敏感内容打印到日志 */
function mask(s) {
  const t = String(s)
  if (t.length <= 6) return '*'.repeat(t.length)
  return `${t.slice(0, 3)}${'*'.repeat(Math.max(3, t.length - 6))}${t.slice(-3)}`
}

/** 把一行里所有命中的真值替换成掩码，避免审计输出二次泄漏 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sanitize(text, raws) {
  let out = String(text)
  for (const raw of raws) {
    if (!raw) continue
    out = out.split(raw).join(mask(raw))
  }
  // 域名/主机名的首段可能单独出现（如包名 cn.xxx.ainews、路径 /xxx/），一并打码
  for (const raw of raws) {
    const label = String(raw).split('.')[0]
    if (label.length < 5) continue
    out = out.replace(new RegExp(`\\b${escapeRe(label)}(?=[./])`, 'gi'), mask(label))
  }
  return out
}

function scanLine(line, words) {
  const hits = []
  for (const rule of RULES) {
    const found = rule.test(line)
    if (!found) continue
    for (const raw of Array.isArray(found) ? found : [found]) {
      hits.push({ id: rule.id, desc: rule.desc, raw })
    }
  }
  for (const w of words) {
    if (line.toLowerCase().includes(w.toLowerCase())) {
      hits.push({ id: 'local-word', desc: '命中本地敏感词表', raw: w })
    }
  }
  return hits
}

/** 取一段提交里「新增的行」，附带文件名 */
function scanCommits(range) {
  const words = loadLocalWords()
  const findings = []
  let patch = ''
  try {
    patch = git(['log', '--no-color', '-p', '--unified=0', '--format=@@@%H %s', range])
  } catch {
    return findings
  }
  let file = '(unknown)'
  let commit = ''
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('@@@')) {
      commit = line.slice(3, 3 + 7)
      continue
    }
    if (line.startsWith('+++ b/')) {
      file = line.slice(6)
      continue
    }
    if (line.startsWith('+++ /dev/null')) {
      file = '(deleted)'
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const content = line.slice(1)
    const hits = scanLine(content, words)
    for (const h of hits) {
      findings.push({
        ...h,
        commit,
        file,
        evidence: mask(h.raw),
        // 片段里把命中的真值全部打码，避免审计日志成为新的泄漏源
        line: sanitize(content.trim().slice(0, 120), hits.map((x) => x.raw)),
      })
    }
  }
  return findings
}

/** 检查提交里是否夹带了禁止路径 */
function scanPaths(range) {
  const findings = []
  let names = ''
  try {
    names = git(['diff', '--name-only', ...range.split('..'), '--'])
  } catch {
    try {
      names = git(['ls-tree', '-r', '--name-only', range])
    } catch {
      return findings
    }
  }
  for (const p of names.split(/\r?\n/).filter(Boolean)) {
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.re.test(p)) findings.push({ id: 'forbidden-path', desc: rule.desc, file: p, evidence: p })
    }
  }
  return findings
}

function report(findings) {
  if (findings.length === 0) {
    console.log('✅ 推送审计通过：未发现服务器信息 / 密钥 / 内部文档')
    return 0
  }
  console.error('\n⛔ 推送已拦截 —— 即将推送的内容里含服务器信息或密钥\n')
  const seen = new Set()
  for (const f of findings) {
    const key = `${f.id}|${f.file}|${f.evidence}`
    if (seen.has(key)) continue
    seen.add(key)
    console.error(`  [${f.id}] ${f.desc}`)
    console.error(`    文件: ${f.file}${f.commit ? `  (提交 ${f.commit})` : ''}`)
    console.error(`    命中: ${f.evidence}`)
    if (f.line) console.error(`    片段: ${f.line}`)
    console.error('')
  }
  console.error('处理方式：把真值移到本地文件（docs/ 或 scripts/audit-words.local），')
  console.error('确认已从本次提交中移除后再推送。若真值已在历史里，需要重写历史才能彻底清除。')
  console.error('')
  return 1
}

function main() {
  const argv = process.argv.slice(2)

  if (argv[0] === '--staged') {
    const words = loadLocalWords()
    const findings = []
    let diff = ''
    try {
      diff = git(['diff', '--cached', '--unified=0'])
    } catch {
      /* ignore */
    }
    let file = '(unknown)'
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith('+++ b/')) {
        file = line.slice(6)
        continue
      }
      if (!line.startsWith('+') || line.startsWith('+++')) continue
      const content = line.slice(1)
      const hits = scanLine(content, words)
      for (const h of hits) {
        findings.push({
          ...h,
          file,
          evidence: mask(h.raw),
          line: sanitize(content.trim().slice(0, 120), hits.map((x) => x.raw)),
        })
      }
    }
    for (const p of git(['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean)) {
      for (const rule of FORBIDDEN_PATHS) {
        if (rule.re.test(p)) findings.push({ id: 'forbidden-path', desc: rule.desc, file: p, evidence: p })
      }
    }
    process.exit(report(findings))
  }

  if (argv[0] === '--range') {
    const range = argv[1]
    if (!range) {
      console.error('用法: node scripts/pre-push-audit.mjs --range <from>..<to>')
      process.exit(2)
    }
    process.exit(report([...scanPaths(range), ...scanCommits(range)]))
  }

  // pre-push 模式：stdin 每行 <local_ref> <local_sha> <remote_ref> <remote_sha>
  let stdin = ''
  try {
    stdin = readFileSync(0, 'utf8')
  } catch {
    stdin = ''
  }
  const lines = stdin.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) {
    // 没有 stdin（手动执行且没给参数）：退化为检查 HEAD 相对上游
    const upstream = (() => {
      try {
        return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim()
      } catch {
        return ''
      }
    })()
    if (!upstream) {
      console.log('ℹ️ 未提供推送范围，且当前分支无上游 —— 跳过审计')
      process.exit(0)
    }
    process.exit(report([...scanPaths(`${upstream}..HEAD`), ...scanCommits(`${upstream}..HEAD`)]))
  }

  const all = []
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.split(/\s+/)
    if (!localSha || ZERO.test(localSha)) continue // 删除分支，无内容可泄
    const range = !remoteSha || ZERO.test(remoteSha) ? localSha : `${remoteSha}..${localSha}`
    all.push(...scanPaths(range), ...scanCommits(range))
  }
  process.exit(report(all))
}

main()
