/** owner: workers/aiChat。AI 心情抽取与到期（packages/aiChat/ai/mood.ts）的内存状态；全 Worker 只有
 * 一份心情，所有群共用。 */

import type { CurrentMood } from "../../../types/aiChat/mood";

/**
 * 当前心情档位与到期时刻；null 表示尚未抽取（Worker 刚启动）或热重载后原档位已从配置删除，下次读取时重抽。
 * 填充：switchMood 在首次读取、到期重抽与 /mood switch 时整体写入；refreshMood 在 mood.json 热重载后
 * 换成同名新档位（保留到期时刻）或清空。
 * 不落盘：Worker 崩溃重建换新 isolate 后为 null，下次拼提示词时重抽。
 * 容量：恒为单个槽位，不随群 teardown 清理。
 */
export const currentMoodState: { current: CurrentMood | null } = { current: null };

/** 测试隔离时清空当前心情（经 resetAiChatWorkerCache）。 */
export function resetAiChatMoodCache(): void {
  currentMoodState.current = null;
}
