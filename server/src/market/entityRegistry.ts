/**
 * 实体映射注册表（v0.44.0 · mapping-2）
 *
 * 为什么单独一层：内置的别名表（universe.aliases）只覆盖 18 家监测公司，
 * 而新闻里出现的大量实体是**产品名、模型名、开源项目、机构**。
 * 这一层负责把这些名字认准，并记录**证据**。
 *
 * 三条硬规则：
 *   1. **精确匹配**，绝不退回模糊包含（"Meta" 不能命中 "Metadata"）
 *   2. **只映射有证据的**：confidence=unverified 的一律留在 unknown，不硬猜
 *   3. **按事件发生时的状态映射**：当时未上市的主体，不能因为后来 IPO 就改成已上市
 *      （见 `listedSince` 字段；本期数据无此情况，但机制保留）
 */

import type { EntityClass } from './entityClass.ts'

export type Confidence = 'confirmed' | 'likely' | 'unverified'

export interface RegistryEntry {
  /** 归一化键（小写、去首尾空格） */
  key: string
  /** 展示名 */
  name: string
  /** 中英文别名（含本名） */
  aliases: string[]
  entityClass: EntityClass
  /** 可直接映射的上市代码（可不在 18 家监测清单内） */
  symbol: string | null
  /** 产品/品牌对应的上市母公司名（未上市时填公司名，symbol 为 null） */
  parentName: string | null
  /** 证据来源：官方页面 / 权威报道标题 / 交易所资料 */
  evidence: string
  confidence: Confidence
  /** 若该主体在某日之后才上市，事件早于该日时不得映射 */
  listedSince?: string
}

/**
 * 注册表。按"先确认、后推测"的顺序排列，便于人工 review。
 *
 * ⚠️ 改这里必须同步：① 提升 entityClass.ts 的 MAPPING_VERSION；
 *    ② 已落库的 observation 不会被改写（它记录的是当时的映射版本）。
 */
export const ENTITY_REGISTRY: RegistryEntry[] = [
  // ---------- 已确认：产品 → 上市母公司 ----------
  {
    key: 'gemini 4 argon',
    name: 'Gemini 4 Argon',
    aliases: ['Gemini 4 Argon', 'Gemini 4'],
    entityClass: 'product',
    symbol: 'GOOGL',
    parentName: 'Alphabet',
    evidence: 'Google 官方发布稿标题「Gemini 4 Argon is now available worldwide as Google\'s most capable frontier model」',
    confidence: 'confirmed',
  },
  {
    key: 'gemini',
    name: 'Gemini',
    aliases: ['Gemini'],
    entityClass: 'product',
    symbol: 'GOOGL',
    parentName: 'Alphabet',
    evidence: 'Google 旗舰模型线，官方 blog 与发布会均以 Google 名义发布',
    confidence: 'confirmed',
  },
  {
    key: '谷歌云',
    name: '谷歌云',
    aliases: ['谷歌云', 'Google Cloud'],
    entityClass: 'product',
    symbol: 'GOOGL',
    parentName: 'Alphabet',
    evidence: 'Alphabet 财报分部 Google Cloud；报道标题「谷歌云推出面向美国政府机构的 Gemini」',
    confidence: 'confirmed',
  },
  {
    key: 'tpu',
    name: 'TPU',
    aliases: ['TPU', 'Cloud TPU'],
    entityClass: 'product',
    symbol: 'GOOGL',
    parentName: 'Alphabet',
    evidence: 'Google 自研加速芯片，官方云文档与 TorchTPU 开源公告均归属 Google',
    confidence: 'confirmed',
  },
  {
    key: 'torchtpu',
    name: 'TorchTPU',
    aliases: ['TorchTPU'],
    entityClass: 'product',
    symbol: 'GOOGL',
    parentName: 'Alphabet',
    evidence: '标题「Google Open-Sources TorchTPU, a Native PyTorch Backend for Cloud TPUs」',
    confidence: 'confirmed',
  },
  {
    key: 'torchneuron',
    name: 'TorchNeuron',
    aliases: ['TorchNeuron'],
    entityClass: 'product',
    symbol: 'AMZN',
    parentName: 'Amazon',
    evidence: '标题「Amazon is taking its biggest shot at Nvidia yet with new TorchNeuron dev tool」+「Amazon opens its AWS Trainium AI chips to every PyTorch developer」',
    confidence: 'confirmed',
  },
  {
    key: 'muse wonder',
    name: 'Muse Wonder',
    aliases: ['Muse Wonder', 'Muse Wonder Full', 'Muse'],
    entityClass: 'product',
    symbol: 'META',
    parentName: 'Meta',
    evidence: '标题「Meta releases its first frontier model, Muse Wonder」；另有「Apple and Meta team up to make Muse AI model run on Mac」',
    confidence: 'confirmed',
  },
  {
    key: 'nemotron 3.5 super vl',
    name: 'Nemotron 3.5 Super VL',
    aliases: ['Nemotron 3.5 Super VL', 'Nemotron'],
    entityClass: 'product',
    symbol: 'NVDA',
    parentName: 'NVIDIA',
    evidence: '标题「NVIDIA Releases Nemotron 3.5 Super VL, a 120B Open Multimodal Agent Model」',
    confidence: 'confirmed',
  },

  // ---------- 已确认：产品 → 未上市母公司 ----------
  {
    key: 'claude',
    name: 'Claude',
    aliases: ['Claude', 'Claude Code'],
    entityClass: 'private',
    symbol: null,
    parentName: 'Anthropic',
    evidence: 'Anthropic 旗舰模型线，公司未上市（无公开股票）',
    confidence: 'confirmed',
  },
  {
    key: 'gpt-6',
    name: 'GPT-6',
    aliases: ['GPT-6', 'GPT-6.1', 'GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6-Astra', 'GPT-6.1-Sol'],
    entityClass: 'private',
    symbol: null,
    parentName: 'OpenAI',
    evidence: 'OpenAI 模型线（DevDay 2026 发布），公司未上市',
    confidence: 'confirmed',
  },
  {
    key: 'codex',
    name: 'Codex',
    aliases: ['Codex'],
    entityClass: 'private',
    symbol: null,
    parentName: 'OpenAI',
    evidence: 'OpenAI 编码产品线，随 GPT-6 一同发布（DevDay 2026 Recap）',
    confidence: 'likely',
  },
  {
    key: 'm3.1 flash',
    name: 'M3.1 Flash',
    aliases: ['M3.1 Flash', 'MiniMax M3.1'],
    entityClass: 'private',
    symbol: null,
    parentName: 'MiniMax',
    evidence: '标题「MiniMax Just Launched M3.1 Flash: 428B MoE Agentic Model at $0.15/M Input」；MiniMax 未上市',
    confidence: 'confirmed',
  },

  // ---------- 已确认：非企业实体（项目 / 机构 / 标准 / 地区） ----------
  {
    key: 'pytorch',
    name: 'PyTorch',
    aliases: ['PyTorch'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '开源深度学习框架，2022 年起由 PyTorch Foundation（Linux 基金会下）治理，不归属单一上市公司',
    confidence: 'confirmed',
  },
  {
    key: 'vllm',
    name: 'vLLM',
    aliases: ['vLLM'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '开源推理引擎项目（UC Berkeley 起源），无对应上市公司',
    confidence: 'confirmed',
  },
  {
    key: 'arxiv',
    name: 'arXiv',
    aliases: ['arXiv'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '康奈尔大学运营的预印本平台，非企业',
    confidence: 'confirmed',
  },
  {
    key: 'artificial analysis',
    name: 'Artificial Analysis',
    aliases: ['Artificial Analysis'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '独立模型评测机构（报道中作为排名来源被引用），非上市公司',
    confidence: 'likely',
  },
  {
    key: 'transformer',
    name: 'Transformer',
    aliases: ['Transformer'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '神经网络架构名称，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: 'cobol',
    name: 'COBOL',
    aliases: ['COBOL'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '编程语言名称，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: '中国',
    name: '中国',
    aliases: ['中国'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '国家/地区，不是企业实体',
    confidence: 'confirmed',
  },

  {
    key: 'muse spark open',
    name: 'Muse Spark Open',
    aliases: ['Muse Spark Open', 'Muse Spark'],
    entityClass: 'product',
    symbol: 'META',
    parentName: 'Meta',
    evidence: '报道标题「Meta 开源权重模型 Muse Spark Open 在 Fireworks 上线」',
    confidence: 'confirmed',
  },
  {
    key: 'kimi',
    name: 'Kimi',
    aliases: ['Kimi', 'Moonshot', 'Moonshot AI', '月之暗面'],
    entityClass: 'private',
    symbol: null,
    parentName: 'Moonshot AI',
    evidence: 'Kimi 为月之暗面（Moonshot AI）的模型产品，公司未上市',
    confidence: 'confirmed',
  },
  {
    key: 'fortran',
    name: 'Fortran',
    aliases: ['Fortran'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '编程语言名称，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: 'multilangbench',
    name: 'MultiLangBench',
    aliases: ['MultiLangBench'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '评测基准（benchmark）名称，不是企业实体',
    confidence: 'likely',
  },

  {
    key: 'vera rubin',
    name: 'Vera Rubin',
    aliases: ['Vera Rubin', 'Vera Rubin Infrastructure'],
    entityClass: 'product',
    symbol: 'NVDA',
    parentName: 'NVIDIA',
    evidence: '标题「Google Cloud and NVIDIA Announce General Availability of NVIDIA Vera Rubin Infrastructure」',
    confidence: 'confirmed',
  },
  {
    key: 'visual basic',
    name: 'Visual Basic',
    aliases: ['Visual Basic'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '编程语言名称，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: '美国',
    name: '美国',
    aliases: ['美国', 'United States'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '国家/地区，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: '英国',
    name: '英国',
    aliases: ['英国', 'United Kingdom'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '国家/地区，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: '工信部',
    name: '工信部',
    aliases: ['工信部', '工业和信息化部'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '中国政府主管部门，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: '美国国土安全部',
    name: '美国国土安全部',
    aliases: ['美国国土安全部', 'DHS', 'Department of Homeland Security'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '美国政府机构，不是企业实体',
    confidence: 'confirmed',
  },
  {
    key: '梁文锋',
    name: '梁文锋',
    aliases: ['梁文锋'],
    entityClass: 'noncorporate',
    symbol: null,
    parentName: null,
    evidence: '人物（DeepSeek 创始人），不是企业实体；其公司 DeepSeek 亦未上市',
    confidence: 'confirmed',
  },

  // ---------- 上市公司，但不在 18 家监测清单内（无行情 → no_price） ----------
  {
    key: 'apple',
    name: 'Apple',
    aliases: ['Apple', '苹果'],
    entityClass: 'listed',
    symbol: 'AAPL',
    parentName: null,
    evidence: 'NASDAQ: AAPL；本项目监测清单未包含，接入行情后即可结算',
    confidence: 'confirmed',
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    aliases: ['Cloudflare'],
    entityClass: 'listed',
    symbol: 'NET',
    parentName: null,
    evidence: 'NYSE: NET；本项目监测清单未包含',
    confidence: 'confirmed',
  },
]

/*
 * 索引必须**同时包含 key 与 aliases**。
 * 踩过的坑：只索引 key 时，"Claude Code"（登记为 Claude 的别名）查不到，
 * 表现为"明明加进注册表了却还是 unknown" —— 极难发现，因为主键本身是命中的。
 */
const BY_KEY = new Map<string, RegistryEntry>()
for (const e of ENTITY_REGISTRY) {
  BY_KEY.set(e.key, e)
  for (const a of e.aliases) BY_KEY.set(a.trim().toLowerCase(), e)
}

/** 精确查找注册表（key 或任一别名，大小写不敏感，不做模糊包含） */
export function lookupRegistry(entity: string): RegistryEntry | null {
  return BY_KEY.get(entity.trim().toLowerCase()) ?? null
}

export const REGISTRY_VERSION = 'mapping-2'
