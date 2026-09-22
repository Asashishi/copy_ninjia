import type { Atmosphere } from "../../../types/atmosphere";
/** owner: workers/antiRaid。 */

/**
 * 群通知风格镜像，权威数据为 main 的 ChatState.aiPersona。
 * main 在人设变更和群状态删除后增量推送，Worker 创建或崩溃重建时由 main 全量重放，
 * 重放先于业务消息。最多 STATE_MANAGED_CHAT_LIMIT 个群，只保留有自定义人设的群；
 * 恢复默认人设、删除群状态或停止 Worker 时清理。无条目表示初始化载荷指定的 Bot 风格，
 * 不沿用旧值；读取侧不修改镜像，也不发起 request/reply。
 * 跨线程恢复顺序见 docs/cn/04-invariants.md。
 */
export const plainAtmosphereChats: Set<number> = new Set();

/**
 * owner: workers/antiRaid。主线程启动快照的默认通知风格，容量一个枚举。
 * 初始化载荷全量注入；业务读取只读，重建由 main 在业务消息前重放，停止时清空。
 * 未注入时为 null，读取使用配置缺省风格，不沿用上一个 Worker 的值。
 */
export const defaultAtmosphereState: { current: Atmosphere | null } = { current: null };
