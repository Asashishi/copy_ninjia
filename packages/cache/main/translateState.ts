import type { TranslateState } from "../../types/translate";

/** owner: main。按群保存翻译会话的权威状态。 */

/**
 * 启动从 state.json 的 translate 恢复，/translate 开始时填充，停止或群 teardown
 * 时删除。最多 STATE_MANAGED_CHAT_LIMIT 群，每群最多 TRANSLATE_CHAT_USER_LIMIT 个
 * 不重复目标，不保留空数组、不淘汰活动会话。Worker 崩溃不影响此表；进程重启由
 * StateStore 恢复，缺少条目表示该群没有翻译目标。每次增删替换只读数组。
 */
export const translateStates: Map<number, readonly TranslateState[]> = new Map();
