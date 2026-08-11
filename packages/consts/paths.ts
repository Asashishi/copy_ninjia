import { join, resolve } from "node:path";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "./environment";

/**
 * 项目内所有文件/目录路径的集中定义。各模块统一从这里取，不再各自散落
 * join(import.meta.dir, ...)。本文件位于 packages/consts/ 下，PROJECT_ROOT 要
 * 往上跳两级。
 */
export const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");

/** 可选进程环境路径真正缺省时返回 undefined，存在但空白时拒绝启动。 */
function optionalRootPath(name: string): string | undefined {
  const value: string | undefined = process.env[name];
  if (value === undefined) return undefined;
  const trimmed: string = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`environment: ${name} must be a non-empty path when present.`);
  }
  return trimmed;
}

/**
 * 所有运行时生成数据的根目录。生产默认保持项目根目录；测试 preload 必须在
 * 任何生产模块加载前注入独立临时目录，从源头隔离真实 I/O，而非依赖每个
 * 测试都记得 mock 路径。
 */
/** 环境变量解析出的可选数据根；仅真正缺省时使用项目根目录。 */
const CONFIGURED_DATA_ROOT: string | undefined = optionalRootPath(RUNTIME_DATA_ROOT_ENV);
/** 是否由部署者显式配置了独立运行时数据根；用于启用生产权限门禁。 */
export const RUNTIME_DATA_ROOT_IS_CONFIGURED: boolean = CONFIGURED_DATA_ROOT !== undefined;
/** 当前进程实际使用的运行时数据根目录。 */
export const RUNTIME_DATA_ROOT: string = CONFIGURED_DATA_ROOT === undefined
  ? PROJECT_ROOT
  : resolve(CONFIGURED_DATA_ROOT);

/** state.json 主文件路径。 */
export const STATE_FILE_PATH: string = join(RUNTIME_DATA_ROOT, "state.json");
/** state.json 的 last-known-good 同目录副本；与主文件使用同一严格 schema。 */
export const STATE_BACKUP_FILE_PATH: string = `${STATE_FILE_PATH}.bak`;
/** 数据目录单实例 owner 锁文件路径。 */
export const LOCK_FILE_PATH: string = join(RUNTIME_DATA_ROOT, "bot.lock");

/** AI 闲聊人设文本（Markdown，修改人设不需要碰代码）。 */
export const PERSONA_PATH: string = join(PROJECT_ROOT, "prompt", "persona.md");

/** 部署配置目录；测试会显式指向受版本控制的 config_example/。 */
export const CONFIG_ROOT: string = resolve(
  optionalRootPath(CONFIG_ROOT_ENV) ?? join(PROJECT_ROOT, "config")
);

/** 应景贴纸包白名单配置文件。 */
export const STICKERS_CONFIG_PATH: string = join(CONFIG_ROOT, "stickers.json");
/** Telegram 反应集合部署配置文件。 */
export const REACTIONS_CONFIG_PATH: string = join(CONFIG_ROOT, "reactions.json");
/** AI 心情档位配置（文案、base weight、天气/时段倍率），见 packages/config/mood.ts。 */
export const MOOD_CONFIG_PATH: string = join(CONFIG_ROOT, "mood.json");
/** 广告检测的部署者示例清单（纯字符串数组），见 packages/config/adSamples.ts。 */
export const AD_SAMPLES_CONFIG_PATH: string = join(CONFIG_ROOT, "ad_samples.json");

/** Telegram Bot token 与超级管理员 ID 的必填部署配置。 */
export const TELEGRAM_CONFIG_PATH: string = join(CONFIG_ROOT, "telegram.json");

/**
 * AI 部署配置；agent 下的各项能力分别配置 provider、api_key、model 与可选
 * base_url，见 packages/config/agent.ts。
 */
export const AGENT_CONFIG_PATH: string = join(CONFIG_ROOT, "agent.json");
/** 一次性 SQLite 迁移读取的旧白名单路径；运行时不得访问。 */
export const WHITELIST_CONFIG_PATH: string = join(CONFIG_ROOT, "whitelist.json");
/** 一次性 SQLite 迁移读取的旧静态黑名单路径；运行时不得访问。 */
export const BLOCKLIST_CONFIG_PATH: string = join(CONFIG_ROOT, "blocklist.json");

/** error 日志落盘目录（diskIOWorker 按日一个 JSON 文件）。 */
export const LOGS_DIR: string = join(RUNTIME_DATA_ROOT, "logs");

/**
 * memory/ 落盘目录：AI 记忆快照（ai/ 下按 chatId 一个 <chatId>.json）、每日
 * 运势缓存（luck/ 下按东京日期一个文件，只留当天）、白名单贴纸包的目录快照
 * （stickers/ 下按 pack short name 一个 <pack>.json，见 aiChat/ai/stickers/catalog.ts）、
 * 待验证当日增量（anti-raid/ 下只保留东京当天），以及滚动 24 小时入群事实
 * （joinlog/），均由 diskIOWorker 落盘，见
 * packages/workers/diskIOWorker.ts。每一类数据各占一个子目录，顶层不放单个
 * 文件。不进 git，与 logs/ 同级对待；AI 记忆快照含群聊逐字明文，部署时应按
 * 敏感数据保护。
 */
export const MEMORY_DIR: string = join(RUNTIME_DATA_ROOT, "memory");
/**
 * SQLite 运行时数据库目录；与 memory/ 平级，只由 Disk I/O Worker 和显式迁移脚本访问。
 */
export const DATABASE_DIR: string = join(RUNTIME_DATA_ROOT, "database");
/** 黑白名单与待踢成员共用的 SQLite 数据库文件。 */
export const IDENTITY_DATABASE_PATH: string = join(DATABASE_DIR, "storage.sqlite");
/** 每群 AI 记忆原子快照目录。 */
export const AI_MEMORY_DIR: string = join(MEMORY_DIR, "ai");
/** 当日运势追加文件与签名密钥目录。 */
export const LUCK_MEMORY_DIR: string = join(MEMORY_DIR, "luck");
/** 当日运势确定性派生与回执签名共用的敏感密钥文件。 */
export const LUCK_RECEIPT_SECRET_PATH: string = join(LUCK_MEMORY_DIR, "receipt-secret.json");
/** 白名单贴纸包视觉目录快照目录。 */
export const STICKER_MEMORY_DIR: string = join(MEMORY_DIR, "stickers");
/** Anti-Raid 待验证增量文件目录；按东京日期命名，只保留当天文件。 */
export const VERIFICATION_MEMORY_DIR: string = join(MEMORY_DIR, "anti-raid");
/**
 * 群成员滚动入群日志目录；按 `<chatId>.<东京日期>.json` 追写，保留最近三个
 * 东京自然日以覆盖跨午夜在途查询；启动时校验保留窗口，
 * `/batch_kick` 查询和新入群事件再按需建立有界缓存。
 */
export const JOIN_LOG_MEMORY_DIR: string = join(MEMORY_DIR, "joinlog");
/**
 * 一次性 SQLite 迁移读取并最终删除的旧黑名单目录；运行时不得访问。
 */
export const BLOCKLIST_MEMORY_DIR: string = join(MEMORY_DIR, "blocklist");
/**
 * 一次性迁移读取的旧动态黑名单文件；运行时权威源已经是 SQLite。
 */
export const BLOCKLIST_FILE_PATH: string = join(BLOCKLIST_MEMORY_DIR, "blocklist.json");
/**
 * 一次性迁移读取的旧待踢成员 outbox 文件；运行时权威源已经是 SQLite。
 */
export const BLOCKLIST_REMOVAL_OUTBOX_PATH: string = join(BLOCKLIST_MEMORY_DIR, "removals.json");

/**
 * 广告检测命中样本的旁路目录。与 memory/ 下其余子目录同级，但性质完全不同：
 * 它**不是运行时状态**，进程从不读它，启动恢复也不碰它——纯粹是给人看的、
 * 用来回头优化 config/ad_samples.json 的原始素材。
 */
export const AD_SAMPLE_MEMORY_DIR: string = join(MEMORY_DIR, "ad-detected");
/**
 * 判定命中并触发封禁的原始样本，追加写入、永不读回。涨过
 * AD_SAMPLE_FILE_MAX_BYTES 时整份改名成 `sample.<东京日期>.json` 归档，
 * 归档只保留最近 15 个东京自然日。
 * 所属模块：workers/diskIO/adSampleFile.ts。
 */
export const AD_SAMPLE_FILE_PATH: string = join(AD_SAMPLE_MEMORY_DIR, "sample.json");

/** Google Cloud 服务账号密钥（/ja_copy 日语翻译用，已进 .gitignore）。 */
export const GOOGLE_AUTH_FILE_PATH: string = join(PROJECT_ROOT, "g-auth.json");

/**
 * 原子重写（写 tmp、rename 覆盖目标路径）统一使用的临时后缀，全项目落盘复用，
 * 见 infra/storage/statePersistence.ts、workers/diskIO/snapshotFiles.ts 的快照
 * 恢复、workers/diskIO/appendOnlyDayFile.ts 的 atomicRewrite。
 *
 * 没有与之配套的「损坏文件隔离」后缀：本项目的设计是解析失败即致命、原地保留
 * 原文件等人来看，从不改名隔离（见 test/infra/storage/stateStore.test.ts 与
 * test/workers/diskIO/luckFiles.test.ts 里「从不产生 .corrupt」的断言）。
 */
export const TMP_FILE_SUFFIX: string = ".tmp";
