/** 贴纸领域公开 API。运行时依赖保持单向：config/sets → catalog →
 * aiChat/ai/tools/stickers 适配层；sendLock 是与目录并列的独立能力。原始缓存集合
 * 刻意不从这里导出，领域外模块不能绕过业务函数改 Map/Set。
 *
 * 这个入口本身只在 AI 闲聊 Worker 里加载（它顺带拉起 sets/catalog 持有的
 * Worker 独占缓存）。主线程要的两个纯函数一律直接 import
 * aiChat/ai/stickers/describe.ts，别走这里。 */
export * from "./catalog";
export * from "./config";
export * from "./describe";
export * from "./sendLock";
export * from "./sets";
