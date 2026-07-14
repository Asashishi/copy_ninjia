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

/** AI 闲聊人设文本（修改人设不需要碰代码）。 */
export const PERSONA_PATH: string = join(PROJECT_ROOT, "prompt", "persona.txt");

// 应景贴纸 / 应景反应的配置文件（白名单、概率、情绪关键词映射）。
export const STICKERS_CONFIG_PATH: string = join(PROJECT_ROOT, "config", "stickers.json");
export const REACTIONS_CONFIG_PATH: string = join(PROJECT_ROOT, "config", "reactions.json");

/** error 日志落盘目录（loggerWorker 按日一个 JSON 文件）。 */
export const LOGS_DIR: string = join(PROJECT_ROOT, "logs");

/** Google Cloud 服务账号密钥（/ja_copy 日语翻译用，已进 .gitignore）。 */
export const GOOGLE_AUTH_FILE_PATH: string = join(PROJECT_ROOT, "g-auth.json");
