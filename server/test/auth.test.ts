import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { verifySessionToken } from '../src/auth.ts'

const secret = 'test-session-signing-secret'
function token(claims: unknown, header: unknown = { alg: 'HS256', typ: 'JWT' }): string {
  const input = [header, claims].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
}

test('会话：兼容 HS256 登录令牌，拒绝错误密钥和被篡改的载荷', () => {
  const signed = token({ email: 'reader@example.com', exp: Date.now() / 1000 + 60 })
  assert.deepEqual(verifySessionToken(signed, secret), { email: 'reader@example.com' })
  assert.equal(verifySessionToken(signed, 'other-test-secret'), null)
  assert.equal(verifySessionToken(signed.replace('eyJ', 'ayJ'), secret), null)
})

test('会话：同字符数的多字节签名返回无效，不抛异常', () => {
  const signed = token({ email: 'reader@example.com' })
  const parts = signed.split('.')
  parts[2] = '界'.repeat(parts[2].length)
  assert.equal(verifySessionToken(parts.join('.'), secret), null)
})

test('会话：拒绝错误算法、非对象载荷、空账号和非法时间声明', (t) => {
  t.mock.method(Date, 'now', () => 2_000_000)
  for (const claims of [null, [], { email: '' }, { email: '   ' },
    { email: 'reader@example.com', exp: 2000 },
    { email: 'reader@example.com', exp: '3000' },
    { email: 'reader@example.com', nbf: 2001 },
    { email: 'reader@example.com', nbf: '1000' }]) {
    assert.equal(verifySessionToken(token(claims), secret), null, JSON.stringify(claims))
  }
  assert.equal(verifySessionToken(token({ email: 'reader@example.com' }, { alg: 'none' }), secret), null)
  assert.equal(verifySessionToken(token({ email: 'reader@example.com' }, null), secret), null)
  assert.deepEqual(verifySessionToken(token({ email: 'reader@example.com', exp: 2001, nbf: 2000 }), secret), { email: 'reader@example.com' })
})
