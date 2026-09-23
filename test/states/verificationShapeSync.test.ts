import { expect, test } from "bun:test";
import type { PendingState } from "../../packages/types/states/verification";
import type { VerificationSnapshotBase } from "../../packages/types/antiRaid/verification";

/**
 * 「待验证成员」这组事实在两处各声明一份：`types/states/verification.ts` 的
 * `PendingState`（Anti-Raid Worker 运行态）与 `types/antiRaid/verification.ts` 的
 * `VerificationSnapshotBase`（落盘快照）。两者不共享基类型，字段改动需人工同步。
 *
 * 下面用两个 `Record<K, true>` 编译期探针分别覆盖两侧字段：任一侧新增、改名或
 * 删除字段会让对应 Record 缺键或多键，编译失败；运行期再核对两张表与
 * SHARED_MEMBER_FACT_KEYS 三者相等，确认探针本身覆盖完整。
 */

/** 运行态里描述成员事实的字段（去掉判别标签）。 */
type PendingFactKey = Exclude<keyof PendingState, "kind">;
/** 落盘快照里描述同一组事实的字段（去掉持久化专属的寻址与代际字段）。 */
type SnapshotFactKey = Exclude<
  keyof VerificationSnapshotBase,
  "chatId" | "userId" | "generation" | "revision"
>;

/** 两侧共有的成员事实清单；改动必须与上面两个类型同时成立。 */
const SHARED_MEMBER_FACT_KEYS: readonly string[] = [
  "label",
  "isBot",
  "announcementMessageId",
  "trackedMessageTimes",
  "invitedBy",
  "reminderMessageId",
  "replyReminderMessageId",
  "replyReminderRequested",
  "welcomeAnchorMessageId",
  "reminderSuperseded",
  "joinedAt",
  "expiresAt",
];

test("待验证成员的运行态与落盘快照声明同一组字段", () => {
  // Record<K, true> 对 K 是全覆盖要求：少一个键报缺失，多一个键报多余属性。
  const runtimeFacts: Record<PendingFactKey, true> = {
    label: true,
    isBot: true,
    announcementMessageId: true,
    trackedMessageTimes: true,
    invitedBy: true,
    reminderMessageId: true,
    replyReminderMessageId: true,
    replyReminderRequested: true,
    welcomeAnchorMessageId: true,
    reminderSuperseded: true,
    joinedAt: true,
    expiresAt: true,
  };
  const persistedFacts: Record<SnapshotFactKey, true> = {
    label: true,
    isBot: true,
    announcementMessageId: true,
    trackedMessageTimes: true,
    invitedBy: true,
    reminderMessageId: true,
    replyReminderMessageId: true,
    replyReminderRequested: true,
    welcomeAnchorMessageId: true,
    reminderSuperseded: true,
    joinedAt: true,
    expiresAt: true,
  };

  const expected: string[] = [...SHARED_MEMBER_FACT_KEYS].sort();
  expect(Object.keys(runtimeFacts).sort()).toEqual(expected);
  expect(Object.keys(persistedFacts).sort()).toEqual(expected);
});
