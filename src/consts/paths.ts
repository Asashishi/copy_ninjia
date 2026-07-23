import { join, resolve } from "node:path";
import { RUNTIME_DATA_ROOT_ENV } from "./environment";

/**
 * 项目内所有文件/目录路径的集中定义。各模块统一从这里取，不再各自散落
 * join(import.meta.dir, ...)。本文件位于 src/consts/ 下，PROJECT_ROOT 要
 * 往上跳两级。
 */
export const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");

/**
 * 所有运行时生成数据的根目录。生产默认保持项目根目录；测试 preload 必须在
 * 任何生产模块加载前注入独立临时目录，从源头隔离真实 I/O，而非依赖每个
 * 测试都记得 mock 路径。
 */
/** 环境变量解析出的可选数据根；空白值按未配置处理。 */
const CONFIGURED_DATA_ROOT: string | undefined = process.env[RUNTIME_DATA_ROOT_ENV]?.trim() || undefined;
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

/** 应景贴纸包白名单配置文件。 */
export const STICKERS_CONFIG_PATH: string = join(PROJECT_ROOT, "config", "stickers.json");
/** Telegram 反应集合部署配置文件。 */
export const REACTIONS_CONFIG_PATH: string = join(PROJECT_ROOT, "config", "reactions.json");
/** AI 心情档位配置（文案、base weight、天气/时段倍率），见 src/config/mood.ts。 */
export const MOOD_CONFIG_PATH: string = join(PROJECT_ROOT, "config", "mood.json");

/** error 日志落盘目录（diskIOWorker 按日一个 JSON 文件）。 */
export const LOGS_DIR: string = join(RUNTIME_DATA_ROOT, "logs");

/**
 * memory/ 落盘目录：AI 记忆快照（ai/ 下按 chatId 一个 <chatId>.json）、每日
 * 运势缓存（luck/ 下按东京日期一个文件，只留当天）、白名单贴纸包的目录快照
 * （stickers/ 下按 pack short name 一个 <pack>.json，见 ai/stickers/catalog.ts），
 * 以及待验证当日增量（anti-raid/ 下只保留东京当天），均由 diskIOWorker
 * 落盘，见 src/workers/diskIOWorker.ts。不进 git，与
 * logs/ 同级对待；AI 记忆快照含群聊逐字明文，部署时应按敏感数据保护。
 */
export const MEMORY_DIR: string = join(RUNTIME_DATA_ROOT, "memory");
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

/** Google Cloud 服务账号密钥（/ja_copy 日语翻译用，已进 .gitignore）。 */
export const GOOGLE_AUTH_FILE_PATH: string = join(PROJECT_ROOT, "g-auth.json");

/**
 * 原子重写（写 tmp、rename 覆盖目标路径）与损坏文件隔离共用的后缀，全项目
 * 落盘统一复用，见 infra/storage/stateStore.ts、
 * workers/diskIO/snapshotFiles.ts 的快照恢复、
 * workers/diskIO/appendOnlyDayFile.ts 的 atomicRewrite。
 */
export const TMP_FILE_SUFFIX: string = ".tmp";
/** 解析失败、隔离保留供排查的损坏文件后缀（不参与正常读取/清理，永久保留）。 */
export const CORRUPT_FILE_SUFFIX: string = ".corrupt";
