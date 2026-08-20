import { expect, test } from "bun:test";
import type { PendingState } from "../../packages/types/states/verification";
import type { VerificationSnapshotBase } from "../../packages/types/antiRaid/verification";

/**
 * 「待验证成员」这组事实在两个领域里各声明了一份：
 * `types/states/verification.ts` 的 `PendingState` 是 Anti-Raid Worker 的运行态，
 * `types/antiRaid/verification.ts` 的 `VerificationSnapshotBase` 是落盘快照。
 *
 * **刻意不合并成一个共享基类型**，两条理由：一是两侧的可变性不同（同域的
 * `ExpelSnapshot` 全是 `readonly`，运行态要就地改写），二是合并会在
 * `types/states/`（Worker 状态机）与 `types/antiRaid/`（持久化协议）之间引入一条
 * 目前并不存在的跨域类型依赖，与「共享类型按领域放置、避免无关协议耦合」相悖。
 *
 * 代价是两张字段表要靠人记着一起改，而漏改**不会有任何编译或运行期报错**：
 * 只给运行态加一个字段，它就是不进快照，表现为「重启之后那个字段没了」。
 * 这里用两个编译期探针把这件事变成编译错误——任一侧新增、改名或删除字段，
 * 对应那个 `Record` 要么缺键要么多键，当场编译失败；运行期再核对一次两张表
 * 与下面这份清单三者相等，保证探针本身没有被改成只覆盖一侧。
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
