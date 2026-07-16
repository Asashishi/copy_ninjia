import { join } from "node:path";

/**
 * 项目内所有文件/目录路径的集中定义。各模块统一从这里取，不再各自散落
 * join(import.meta.dir, ...)。本文件位于 src/consts/ 下，PROJECT_ROOT 要
 * 往上跳两级。
 */
export const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");

// 持久化文件：各群状态 + copy 类命令的全局冷却时钟 + 反刷群私密模式镜像
// 合并存在同一个 state.json 里（结构与为何合并见 types/chatState.ts 的
// StateFileSchema）/ 单实例锁。
export const STATE_FILE_PATH: string = join(PROJECT_ROOT, "state.json");
export const LOCK_FILE_PATH: string = join(PROJECT_ROOT, "bot.lock");

/** AI 闲聊人设文本（Markdown，修改人设不需要碰代码）。 */
export const PERSONA_PATH: string = join(PROJECT_ROOT, "prompt", "persona.md");

// 应景贴纸 / 应景反应的配置文件（白名单、概率、情绪关键词映射）。
export const STICKERS_CONFIG_PATH: string = join(PROJECT_ROOT, "config", "stickers.json");
export const REACTIONS_CONFIG_PATH: string = join(PROJECT_ROOT, "config", "reactions.json");

/** error 日志落盘目录（diskIOWorker 按日一个 JSON 文件）。 */
export const LOGS_DIR: string = join(PROJECT_ROOT, "logs");

/**
 * memory/ 落盘目录：AI 记忆快照（ai/ 下按 chatId 一个 <chatId>.json）、每日
 * 运势缓存（luck/ 下按东京日期一个文件，只留当天）、白名单贴纸包的目录快照
 * （stickers/ 下按 pack short name 一个 <pack>.json，见 ai/stickerCatalog.ts），
 * 均由 diskIOWorker 落盘，见 src/workers/diskIOWorker.ts。不进 git，与
 * logs/ 同级对待；AI 记忆快照含群聊逐字明文，部署时应按敏感数据保护。
 */
export const MEMORY_DIR: string = join(PROJECT_ROOT, "memory");
export const AI_MEMORY_DIR: string = join(MEMORY_DIR, "ai");
export const LUCK_MEMORY_DIR: string = join(MEMORY_DIR, "luck");
export const STICKER_MEMORY_DIR: string = join(MEMORY_DIR, "stickers");

/** Google Cloud 服务账号密钥（/ja_copy 日语翻译用，已进 .gitignore）。 */
export const GOOGLE_AUTH_FILE_PATH: string = join(PROJECT_ROOT, "g-auth.json");

/**
 * 原子重写（写 tmp、rename 覆盖目标路径）与损坏文件隔离共用的后缀，全项目
 * 落盘统一复用，见 infra/storage.ts 的 persistStateJson、
 * workers/diskIO/snapshotFiles.ts 的 atomicWriteJson/quarantine、
 * workers/diskIO/appendOnlyDayFile.ts 的 atomicRewrite。
 */
export const TMP_FILE_SUFFIX: string = ".tmp";
/** 解析失败、隔离保留供排查的损坏文件后缀（不参与正常读取/清理，永久保留）。 */
export const CORRUPT_FILE_SUFFIX: string = ".corrupt";
