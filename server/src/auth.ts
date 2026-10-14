import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config } from './config.ts'

/**
 * 登录鉴权：校验骑行看板下发的 cd_session Cookie（JWT / HS256，共享 JWT_SECRET）。
 *
 * ⚠️ 合规要求（见 docs/合规检查清单.md 第一节）：本项目不得面向公众，
 *   所有 /api/* 必须鉴权；未配置 JWT_SECRET 时不拦截（仅本地开发），上线前必须配置。
 */
function base64UrlToJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
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
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  if (signature.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null

  const claims = base64UrlToJson(payload)
  if (!claims || typeof claims.email !== 'string') return null
  // exp 若存在则校验（秒级时间戳）
  if (typeof claims.exp === 'number' && Date.now() / 1000 > claims.exp) return null

  return { email: claims.email }
}

export function registerAuth(app: FastifyInstance): void {
  if (!config.jwtSecret) {
    app.log.warn('JWT_SECRET 未配置 —— 鉴权已关闭，仅供本地开发；上线前必须配置')
    return
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
