import Fastify from 'fastify'
import { SEED_SOURCES } from './collector/sources.ts'
import { seedSources } from './collector/store.ts'
import { config } from './config.ts'
import { getDb } from './db.ts'
import { registerAuth } from './auth.ts'
import { newsRoutes } from './routes/news.ts'
import { startScheduler } from './scheduler.ts'

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
})

// 鉴权必须在注册路由之前（未配置 JWT_SECRET 时只告警不拦截）
registerAuth(app)

await app.register(newsRoutes)

// 启动即建表（幂等）并写入源清单（幂等）
const db = getDb()
seedSources(db, SEED_SOURCES)

try {
  await app.listen({ host: config.host, port: config.port })
  startScheduler(app)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
