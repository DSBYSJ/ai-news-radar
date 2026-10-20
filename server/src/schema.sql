-- AI 资讯趋势雷达 · 表结构
-- 依据：docs/数据与AI设计.md 第一节（改动时同步更新该文档）
-- 约定：所有时间戳统一存 UTC ISO 字符串

-- 1. 源清单
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,   -- 源标识，如 'openai-news'
  name          TEXT NOT NULL,      -- 显示名
  url           TEXT NOT NULL,      -- feed / API 地址
  kind          TEXT NOT NULL,      -- 'rss' | 'api'
  weight        INTEGER DEFAULT 1,  -- 来源质量权重 1~3（打分用）
  enabled       INTEGER DEFAULT 1,
  last_fetch_at TEXT,               -- UTC ISO
  last_status   TEXT                -- 'ok' | 'error:...'
);

-- 2. 原始条目（落地层，去重前）
CREATE TABLE IF NOT EXISTS raw_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL,
  guid         TEXT NOT NULL,        -- 源内唯一标识（guid / id / link）
  url          TEXT NOT NULL,
  url_norm     TEXT NOT NULL,        -- 归一化 URL（剥离 utm_* 等追踪参数）
  title        TEXT NOT NULL,
  summary      TEXT,                 -- 源摘要（已清 HTML 标签）
  content      TEXT,                 -- 正文纯文本（仅当源提供全文时；按天清理，见 npm run prune）
  published_at TEXT NOT NULL,        -- 统一 UTC ISO，展示层再转本地
  fingerprint  TEXT NOT NULL,        -- 标题指纹
  fetched_at   TEXT NOT NULL,
  UNIQUE(source_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_raw_fingerprint ON raw_items(fingerprint);
CREATE INDEX IF NOT EXISTS idx_raw_published   ON raw_items(published_at);

-- 3. 成品表（AI 加工后）
CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_id       INTEGER NOT NULL REFERENCES raw_items(id),
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  tldr         TEXT,                 -- 第 1 级深度：一句话
  summary      TEXT,                 -- 第 3 级深度：2~3 句中文摘要
  category     TEXT NOT NULL,        -- 固定枚举，见 docs/数据与AI设计.md 第二节
  entities     TEXT,                 -- JSON 数组：["OpenAI","GPT-5"]
  score        INTEGER,              -- 重要性 0~100
  score_parts  TEXT,                 -- JSON 明细（可解释性，便于调参）
  sentiment    TEXT,                 -- positive / neutral / negative（情感判定，可空）
  event_key    TEXT,                 -- 事件聚类键（第 4 层用）
  published_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_cat_date ON articles(category, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_event    ON articles(event_key);
-- 一条原始条目只允许产出一条成品（重复加工安全）
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_raw ON articles(raw_id);

-- 4. 实体提及（趋势统计用）
CREATE TABLE IF NOT EXISTS mentions (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  entity     TEXT NOT NULL,          -- 规范化后的实体名
  PRIMARY KEY (article_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity);

-- 5. 事件聚类（趋势第 4 层核心）
CREATE TABLE IF NOT EXISTS events (
  event_key     TEXT PRIMARY KEY,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  source_count  INTEGER NOT NULL,    -- 跨源交叉度：几个独立源报道过
  article_count INTEGER NOT NULL,
  title_repr    TEXT NOT NULL,       -- 代表标题
  category      TEXT NOT NULL
);

-- 6. 事件聚类输出（跨源交叉度）—— 同日聚类，SimHash 相似度 ≥0.75 或实体交集 ≥2
CREATE TABLE IF NOT EXISTS event_clusters (
  event_id             TEXT PRIMARY KEY,
  publish_date         TEXT NOT NULL,        -- UTC 日期（仅同日聚类）
  representative_title TEXT NOT NULL,        -- 代表标题（组内最早一条）
  source_count         INTEGER NOT NULL,     -- 独立源数量（distinct）
  article_count        INTEGER NOT NULL,     -- 文章总数
  sources_list         TEXT NOT NULL,        -- JSON 数组：全部来源名
  category             TEXT NOT NULL,
  first_seen           TEXT NOT NULL,
  last_seen            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_clusters_date ON event_clusters(publish_date);

-- 7. 突发检测输出（14 天滑动基线 z-score，仅存 z ≥ 阈值 的行）
CREATE TABLE IF NOT EXISTS burst_detection (
  date          TEXT NOT NULL,     -- UTC 日期
  category      TEXT NOT NULL,     -- 分类（另有 'all' 表示全站）
  article_count INTEGER NOT NULL,
  baseline_mean REAL NOT NULL,     -- 前 14 天滑动均值
  baseline_std  REAL NOT NULL,     -- 前 14 天滑动标准差
  z_score       REAL NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (date, category)
);

-- 8. 每日总结（简报）
CREATE TABLE IF NOT EXISTS daily_summaries (
  date       TEXT PRIMARY KEY,       -- UTC 日期 YYYY-MM-DD（与趋势图分桶一致）
  title      TEXT NOT NULL,          -- 一句话主题
  content    TEXT NOT NULL,          -- 简报正文（纯文本：综述 / 分类要点 / 关注）
  highlights TEXT,                   -- JSON：当日重点条目 [{title,url,sourceName,category,sourceCount,score}]
  stats      TEXT,                   -- JSON：{total,byCategory,crossSource,prevTotal,deltaPct,topSources}
  model      TEXT NOT NULL,          -- 'deepseek-chat' | 'statistical'（AI 不可用时的统计兜底版）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 9. 文章向量（自然语言问答的本地检索用）
-- 说明：DeepSeek 没有 embeddings 接口，这里用零依赖的「哈希 TF 向量」（L2 归一化后存 BLOB）
-- fingerprint = title+tldr+summary 的 sha1 前 16 位，内容变了自动重算，不需要手工维护
CREATE TABLE IF NOT EXISTS article_vectors (
  article_id  INTEGER PRIMARY KEY REFERENCES articles(id),
  dim         INTEGER NOT NULL,
  vec         BLOB    NOT NULL,     -- Float32Array(dim)
  model       TEXT    NOT NULL,     -- 'hashed-tf-v1'
  fingerprint TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
