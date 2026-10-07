/** owner: main。黑名单群级处置状态；身份热查询与未 ACK 写入由 cache/main/identityStorage.ts 持有。 */

import { createKeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type {
  BlockedMemberRemover,
  BlocklistSweepPageState,
  BlocklistSweepRecord,
  BlocklistSweepSchedulerState,
  PendingBlockedRemoval,
} from "../../types/blocklist";
/**
 * 白名单成员关系与动态黑名单新增共用的主线程串行链。
 *
 * `/white enable` 的「确认未拉黑 -> 原子写入并发布白名单」跨越异步磁盘 I/O，
 * 与 Worker 回投的广告判定触发的同步 `blockUser` 经同一条链排队。
 *
 * 所有调用都必须经 packages/infra/identityPolicy/coordination.ts；失败被尾链吸收，下一次
 * 操作照常继续。队列只保存一个 Promise，不随身份数增长，进程重启后从已决议的 Promise 重建。
 */
export const protectedIdentityMutationQueue: { current: Promise<void> } = {
  current: Promise.resolve(),
};

/**
 * 动态黑名单处置的逐身份串行尾链。
 *
 * owner 是主线程；广告命中的「拉黑、落盘、登记并投递封禁」、`/block enable` 的跨群封禁扇出
 * （提交给延迟命令执行器时即占位，commands/blocklistFanOut.ts）与 `/block disable` 的
 * 「删名单、落盘、跨群解封」按同一身份的到达顺序完整结算，不同身份互不阻塞。
 * 每条尾链结算后立即删除，容量等于当前仍在处理的身份数；进程重启后从空表重建。
 * 只经 blocklistIdentityMutationRunner 读写。
 */
export const blocklistIdentityMutationQueues: Map<number, Promise<void>> = new Map();

/**
 * blocklistIdentityMutationQueues 上的逐身份串行执行器（libs/keyedSerialTaskRunner.ts）。
 * 同一身份的处置可跨 await 持有串行位，异常交回调用方、不阻塞后续处置；与
 * infra/identityPolicy/coordination.ts 的全局互斥临界区职责不同。
 */
export const blocklistIdentityMutationRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(blocklistIdentityMutationQueues);

/**
 * 黑名单销号计数的主线程串行尾链（infra/blocklist/participantInvalid.ts）。
 *
 * 每条带观测的 Anti-Raid 处置回执到达时追加一步，按到达顺序累加或清零
 * `participantInvalidCount`；失败被尾链吸收，下一条回执照常处理。holder 只保存
 * 尾部 Promise；排队中的步骤与尚未结算的回执一一对应，每步持有该回执的两组 ID
 * （各不超过一页 BLOCKLIST_SWEEP_PAGE_SIZE），步骤结算后释放。Anti-Raid Worker
 * 崩溃不影响本链；停机不等待本链，终局 flush 之后的计数变化随进程丢弃，计数本身
 * 随黑名单条目持久化，进程重启后尾链从空开始。
 */
export const blocklistParticipantInvalidQueue: { current: Promise<void> } = {
  current: Promise.resolve(),
};

/**
 * 已投给入群守卫线程、但还没收到落地回执的处置批次（removalId → 入参 + 投递
 * 计数）。
 *
 * 生命周期：sweepBlockedMembers / claimBlockedJoiner 投递前写入。删除只发生在
 * 「这批不再需要执行」时，分三类：
 * 1. 收到 `complete: true` 回执；
 * 2. 权威状态取消：`/block disable` 摘掉用户，或 forgetChatBlocklistWork 停管群；
 * 3. 同群的补扫批次被新一轮补扫取代。
 * 投递拒绝、屏障超时、落盘失败与副作用失败都不删除，恢复边界是 durable outbox
 * （见 infra/blocklist/）。
 *
 * Worker 崩溃重建时整表重投；处置只含幂等的封禁副作用。容量由
 * BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES 硬顶背压；attempts 只用于持久化诊断，
 * 不触发销毁。
 */
export const pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();

/** 处置批次编号发号器；只在主线程自增，用于回执对账。 */
export const blocklistRemovalCounter: { current: number } = { current: 0 };

/**
 * 各群的补扫进度。「是管理员 && 已 /init enable」成立时补扫一次，补扫成功才记
 * sweptAt（见 infra/blocklist/）。失败后的重试挂在管理员身份观测上，由 nextRetryAt 限流。
 *
 * sweptAt 写下后是闩锁，只有两条路径能打开：停管后重新接管，或
 * infra/blocklist/ 的 requestBlocklistResweep 显式请求重扫；后者对应 `/block`
 * 某个群封禁失败、秒踢批次没落定这类「这个群里还留着人」的信号。
 *
 * 生命周期：投递时写入，回执时更新；群被 /init disable、机器人被撤管理员或
 * 移出群时由 infra/blocklist/ 的 forgetChatBlocklistWork 连同在途批次一起
 * 清掉，重新接管后再补扫一次；进程重启后从空表重建。
 * 容量按本进程见过的管理员群计，随停管即时释放。
 */
export const blocklistSweepState: Map<number, BlocklistSweepRecord> = new Map();

/**
 * 当前补扫 removalId 对应的唯一在途游标页。
 *
 * 填充：首/续页投递前；清理：页失败、整轮落定、群停管、任务被新补扫取代或
 * Worker 重建从空游标重放时。权威线程是 main，容量不超过受管群上限；每群同时
 * 只有一页等待回执，因此 Anti-Raid mailbox 不会随黑名单总长度增长。
 */
export const blocklistSweepPages: Map<number, BlocklistSweepPageState> =
  new Map();

/**
 * 主线程唯一黑名单补扫 timer owner。
 *
 * init 后由 infra/blocklist/sweep.ts 按所有群最近的 nextRetryAt 填充；每次状态推进
 * 都重算最近截止时间，停机 quiesce 时清除。进程重启后由启动全量补扫重建；容量
 * 恒为一个 timer，不随群数增长。
 */
export const blocklistSweepSchedulerState: BlocklistSweepSchedulerState = {
  timer: null,
  scheduledAt: null,
  accepting: false,
  runSweep: null,
};

/** 未注册 owner 时的 no-op，投出去的条数恒为 0。 */
const noBlockedMemberRemover: BlockedMemberRemover = (): Promise<number> => Promise.resolve(0);

/**
 * 黑名单处置的执行 owner（入群守卫代理 packages/antiRaid/blocklistGuard.ts 在启动时
 * 反向注册）。单槽位，不随聊天或事件增长；infra 侧只经它分发，不静态依赖
 * Anti-Raid 业务模块（见 docs/cn/04-invariants.md 的 owner 约束）。
 */
export const blockedMemberRemoverHolder: { current: BlockedMemberRemover } = {
  current: noBlockedMemberRemover,
};
