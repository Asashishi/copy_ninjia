export type ChatRuntimeOwner = "copy" | "translate" | "gag" | "aiChat" | "antiRaid" | "qa" | "wed" | "joinLog";
/**
 * 一次群 teardown 的起因，决定 owner 是只停运行态还是连同本群持久化数据一并删除。
 *
 * - `explicitDisable`：超级管理员 `/init disable`。机器人仍在群里、仍可调 API，
 *   验证按钮等残留消息当场删除；本群的持久化数据全部清除。
 * - `departed`：机器人被移出群（left/kicked）。持久化数据全部清除，不再发出任何
 *   出站 API。
 * - `lostAuthority`：机器人仍在群里、被撤销管理员。只停运行态，本群的配置、成员集合、
 *   入群日志与问答保留；AI 记忆由 aiChat owner 在任何一次 teardown 里一并删除。
 *
 * 判定是否删除数据一律走 libs/chatTeardown.ts 的 purgesChatData，各 owner 不手写
 * 字面量比较（见 docs/cn/04-invariants.md 的群 teardown）。
 */
export type ChatTeardownReason = "explicitDisable" | "departed" | "lostAuthority";
export type ChatTeardownCallback = (
  chatId: number,
  reason: ChatTeardownReason
) => void | Promise<void>;
