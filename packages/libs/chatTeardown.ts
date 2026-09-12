import type { ChatTeardownReason } from "../types/chatTeardown";

/**
 * 本次 teardown 是否要连同本群的持久化数据一并删除。
 *
 * `explicitDisable`（`/init disable`）与 `departed`（被移出群）都表示「本天才不再管
 * 这个群了」，本群的 `/wed` 成员集合、入群日志、问答与 `chat_states` 行全部删除；
 * `lostAuthority`（仍在群里、只是被撤了管理员）只停运行态，这几样原样留着——权限
 * 随时可能加回来，那时它们必须还在。
 *
 * **AI 记忆不看这个判定**：aiChat owner 在任何一次 teardown 里都删，口径与
 * `/ai_chat disable` 一致（见 aiChat/workerBridge.ts 的 registerChatTeardown）。
 *
 * 收在这一个判定里而不是让各 owner 各写一次 `reason === "..."`：新增一个会删数据的
 * 起因时，改这里就够了，不会漏掉某个 owner（见 docs/cn/04-invariants.md 的群 teardown）。
 */
export function purgesChatData(reason: ChatTeardownReason): boolean {
  return reason !== "lostAuthority";
}
