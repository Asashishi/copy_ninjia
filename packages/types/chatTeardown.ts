export type ChatRuntimeOwner = "copy" | "translate" | "gag" | "aiChat" | "antiRaid" | "qa" | "wed" | "joinLog";
/**
 * 一次群 teardown 的起因，决定 owner 是只停运行态还是连同本群持久化数据一并删除。
 *
 * - `explicitDisable`：超级管理员 `/init disable`。机器人仍在群里、仍可调 API，
 *   因此验证按钮之类的残留消息要当场删掉；本群的持久化数据全部清除。
 * - `departed`：机器人被移出群（left/kicked）。持久化数据同样全部清除，但一条
 *   出站 API 都不能再发——人已经不在那个群里了。
 * - `lostAuthority`：仍在群里、只是被撤了管理员。**只停运行态**：管理员权限随时
 *   可能加回来，那时本群的配置、成员集合、入群日志与问答必须原样还在。AI 记忆是
 *   例外，它由 aiChat owner 在任何一次 teardown 里一并删掉。
 *
 * 判定「要不要删数据」一律走 libs/chatTeardown.ts 的 purgesChatData，不在各 owner
 * 里手写字面量比较（见 docs/cn/04-invariants.md 的群 teardown）。
 */
export type ChatTeardownReason = "explicitDisable" | "departed" | "lostAuthority";
export type ChatTeardownCallback = (
  chatId: number,
  reason: ChatTeardownReason
) => void | Promise<void>;
