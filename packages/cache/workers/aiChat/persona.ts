/** owner: workers/aiChat。 */
/**
 * 填充：主线程群状态是权威源；状态变更时增量推送，Worker 初始化/重建时由主线程全量重放。
 * 本线程仅读取此镜像，只有协议入口更新；最多 STATE_MANAGED_CHAT_LIMIT 个群。
 * 清理：NULL 更新及群删除清除条目，停止时清空；Worker 重建从空表恢复，无条目使用默认 persona.md。
 */
export const chatPersonas: Map<number, string> = new Map();
