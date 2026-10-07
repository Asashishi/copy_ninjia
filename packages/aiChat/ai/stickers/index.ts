/** 贴纸领域公开 API。运行时依赖保持单向：config/sets → catalog →
 * aiChat/ai/tools/stickers 适配层。原始缓存集合不从这里导出，领域外模块只能经
 * 业务函数改 Map/Set。
 *
 * 本入口只在 AI 闲聊 Worker 里加载（会引入 sets/catalog 持有的 Worker 独占缓存）。
 * 主线程使用的两个纯函数直接 import aiChat/ai/stickers/describe.ts。 */
export * from "./catalog";
export * from "./describe";
export * from "./sets";
