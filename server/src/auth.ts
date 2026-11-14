import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config } from './config.ts'

/**
 * 登录鉴权：校验骑行看板下发的 cd_session Cookie（JWT / HS256，共享 JWT_SECRET）。
 *
 * ⚠️ 合规要求（见 docs/合规检查清单.md 第一节）：本项目不得面向公众，
 *   所有 /api/* 必须鉴权；生产环境未配置 JWT_SECRET 时拒绝启动。
 */
function base64UrlToJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * 校验会话令牌（与骑行看板的 jsonwebtoken(HS256) 兼容）。
 * 导出以便单测/兼容性验证 —— 已用骑行真实签发的令牌做过双向实测。
 */
export function verifySessionToken(token: string, secret: string): { email: string } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, payload, signature] = parts
  // 先限制签名的字符集，避免等字符数的多字节输入令 timingSafeEqual 抛异常。
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return null
  if (base64UrlToJson(header)?.alg !== 'HS256') return null
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  if (signature.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null

  const claims = base64UrlToJson(payload)
  if (!claims || typeof claims.email !== 'string' || !claims.email.trim()) return null
  const now = Date.now() / 1000
  // NumericDate 必须为有限数字；到期时刻即失效，nbf 到达前不接受。
  if (claims.exp !== undefined &&
    (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || now >= claims.exp)) return null
  if (claims.nbf !== undefined &&
    (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || now < claims.nbf)) return null

  return { email: claims.email }
}

/**
 * 鉴权配置校验（fail-closed）
 *
 * 旧行为是 fail-open：JWT_SECRET 没配就**完全不注册鉴权钩子**，所有 /api/* 敞开。
 * 本地开发方便，但生产环境一旦漏配环境变量（换机器、重装、.env 没带过来），
 * 接口会静默对公网开放 —— 而页面上一切正常，没人会发现。
 *
 * 所以：生产环境没密钥 → **直接抛错、拒绝启动**。
 * 宁可站点 502（一眼看出问题），也不要"看起来正常但数据全裸"。
 */
export function assertAuthConfig(opts: { nodeEnv: string; jwtSecret: string }): void {
  if (opts.jwtSecret.trim().length > 0) return
  if (opts.nodeEnv === 'production') {
    throw new Error(
      '生产环境必须配置 JWT_SECRET（fail-closed）：未配置时拒绝启动。' +
        '请检查 server/.env 是否随部署一起带上。',
    )
  }
}

export function registerAuth(app: FastifyInstance): void {
  assertAuthConfig({ nodeEnv: config.nodeEnv, jwtSecret: config.jwtSecret })

  if (!config.jwtSecret) {
    app.log.warn('JWT_SECRET 未配置 —— 鉴权已关闭，仅供本地开发；生产环境会拒绝启动')
    return
  }

  if (config.nodeEnv === 'production' && config.allowedEmails.length === 0) {
    // 不阻断启动：共享同一套登录态的账号本来就可能只有自己。但要提醒。
    app.log.warn(
      'ALLOWED_EMAILS 为空 —— 任何持有有效 cd_session 的账号都能访问本站数据。' +
        '若骑行看板有多个用户，建议配置白名单。',
    )
  }

  app.addHook('onRequest', async (req, reply) => {
    const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim())
    const token = cookies
      .find((c) => c.startsWith('cd_session='))
      ?.slice('cd_session='.length)

    if (!token) return reply.code(401).send({ error: '未登录' })

    const session = verifySessionToken(token, config.jwtSecret)
    if (!session) return reply.code(401).send({ error: '会话无效' })

    if (config.allowedEmails.length > 0 && !config.allowedEmails.includes(session.email)) {
      return reply.code(403).send({ error: '无访问权限' })
    }

    ;(req as typeof req & { user?: { email: string } }).user = { email: session.email }
  })
}
