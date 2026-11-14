import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'news-audit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, 'scripts'))
  copyFileSync(new URL('./pre-push-audit.mjs', import.meta.url), path.join(dir, 'scripts/pre-push-audit.mjs'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Audit Test')
  git('config', 'user.email', 'audit@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('add', 'scripts/pre-push-audit.mjs')
  git('commit', '-qm', 'baseline')
  const base = git('rev-parse', 'HEAD')
  const put = (name, content) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), content)
  }
  const audit = (...args) => spawnSync(process.execPath, ['scripts/pre-push-audit.mjs', ...args], {
    cwd: dir, encoding: 'utf8', input: '',
  })
  return { git, put, audit, base }
}

test('推送审计：无法解析 Git 范围时拒绝，不能静默通过', (t) => {
  const r = repo(t)
  assert.equal(r.audit('--range', 'missing..HEAD').status, 2)
  assert.equal(r.audit().status, 2, '无上游、无推送范围时必须拒绝')
})

test('推送审计：暂存区拦截根环境文件、数据库和中文内部文档', (t) => {
  const r = repo(t)
  for (const name of ['.env', '.env.production', 'backup.db', 'public/login.html', 'docs/交接说明.md']) {
    r.put(name, 'placeholder')
    r.git('add', name)
    assert.equal(r.audit('--staged').status, 1, name)
    r.git('reset', '-q', 'HEAD', '--', name)
  }
  r.put('.env.example', 'EXAMPLE_TOKEN=')
  r.git('add', '.env.example')
  assert.equal(r.audit('--staged').status, 0, '空值配置模板应允许提交')
})

test('推送审计：中间提交夹带再删除的内部文档仍被拦截', (t) => {
  const r = repo(t)
  r.put('docs/内部说明.md', 'placeholder')
  r.git('add', 'docs')
  r.git('commit', '-qm', 'add internal file')
  r.git('rm', '-q', 'docs/内部说明.md')
  r.git('commit', '-qm', 'remove internal file')
  assert.equal(r.audit('--range', `${r.base}..HEAD`).status, 1)
  const parent = r.git('rev-parse', 'HEAD^')
  assert.equal(r.audit('--range', `${parent}..HEAD`).status, 0, '只删除既有敏感文件允许通过')
})

test('推送审计：中间提交的密钥内容即使删除也拦截，并掩码输出', (t) => {
  const r = repo(t)
  const fake = ['sk-', 'a'.repeat(24)].join('')
  r.put('fixture.txt', fake)
  r.git('add', 'fixture.txt')
  r.git('commit', '-qm', 'add fixture')
  r.git('rm', '-q', 'fixture.txt')
  r.git('commit', '-qm', 'remove fixture')
  const result = r.audit('--range', `${r.base}..HEAD`)
  assert.equal(result.status, 1)
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fake), '审计日志不能再次泄露真值')
})
