/** 贴纸领域公开 API。运行时依赖保持单向：config/sets → catalog →
 * ai/tools/stickers 适配层；sendLock 是与目录并列的独立能力。原始缓存集合
 * 刻意不从这里导出，领域外模块不能绕过业务函数改 Map/Set。 */
export * from "./catalog";
export * from "./config";
export * from "./sendLock";
export * from "./sets";
