import type { ChatTeardownReason } from "../types/chatTeardown";

/**
 * 本次 teardown 是否要连同本群的持久化数据一并删除。
 *
 * `explicitDisable`（`/init disable`）与 `departed`（被移出群）删除本群的 `/wed`
 * 成员集合、入群日志、问答与 `chat_states` 行；`lostAuthority`（仍在群里、被撤销
 * 管理员）只停运行态，这几项保留。
 *
 * AI 记忆不看这个判定：aiChat owner 在任何一次 teardown 里都删，口径与
 * `/ai_chat disable` 一致（见 aiChat/workerBridge.ts 的 registerChatTeardown）。
 *
 * 各 owner 经本函数判定是否删除数据，不手写 `reason === "..."`（见
 * docs/cn/04-invariants.md 的群 teardown）。
 */
export function purgesChatData(reason: ChatTeardownReason): boolean {
  return reason !== "lostAuthority";
}
