import type {
  BlockedMemberRemover,
  BlocklistSweepRecord,
  BlocklistSweepSchedulerState,
  PendingBlockedRemoval,
} from "../../types/blocklist";
/** 黑名单群级处置状态；身份热查询与未 ACK 写入由 cache/main/identityStorage.ts 持有。 */

/**
 * 白名单成员关系与动态黑名单新增共用的主线程串行链。
 *
 * `/white enable` 的「确认未拉黑 -> 原子写入并发布白名单」会跨越异步磁盘 I/O；
 * 同时广告判定可从 Worker 回投并同步 `blockUser`。两者若各自排队，同一身份会
 * 在白名单写盘期间被拉黑，留下启动门禁下一次必然拒绝的矛盾状态。
 *
 * 所有调用都必须经 packages/infra/identityPolicy.ts；失败会被尾链吸收，下一次
 * 操作仍可继续。队列只保存一个 Promise，不随身份数增长，进程重启后自然重建。
 */
export const protectedIdentityMutationQueue: { current: Promise<void> } = {
  current: Promise.resolve(),
};

/**
 * 动态黑名单处置的逐身份串行尾链。
 *
 * owner 是主线程；广告命中的「拉黑、落盘、登记并投递封禁」与 `/unblock` 的
 * 「删名单、落盘、跨群解封」必须按同一身份的到达顺序完整结算，否则较早广告
 * 任务可能在较晚 `/unblock` 之后补登记旧封禁。不同身份互不阻塞。每条尾链结算
 * 后立即删除，因此容量只等于当前仍在处理的身份数；进程重启后自然重建。
 */
export const blocklistIdentityMutationQueues: Map<number, Promise<void>> = new Map();

/**
 * 已投给入群守卫线程、但还没收到落地回执的处置批次（removalId → 入参 + 投递
 * 计数）。
 *
 * 生命周期：sweepBlockedMembers / claimBlockedJoiner 投递前写入。删除只在
 * 「这批不再需要执行」时发生，分成三类：
 * 1. 收到 `complete: true` 回执；
 * 2. 权威状态取消：`/unblock` 摘掉用户，或 forgetChatBlocklistWork 停管群；
 * 3. 同群的补扫批次被新一轮补扫取代（名单只增不减，新快照是旧批次的超集）。
 * 投递拒绝、屏障超时、落盘失败与副作用失败都不删除：durable outbox 是独立
 * 于 Telegram update 重投的恢复边界（见 infra/blocklist/）。
 *
 * Worker 崩溃重建时整表重投——处置是纯副作用，重复 ban 幂等，漏掉却意味着
 * 那个人一直坐在群里。容量由 BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES 硬顶背压；
 * attempts 只用于持久化诊断，达到告警阈值也不能销毁安全任务。
 */
export const pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();

/** 处置批次编号发号器；只在主线程自增，用于回执对账。 */
export const blocklistRemovalCounter: { current: number } = { current: 0 };

/**
 * 各群的补扫进度。「是管理员 && 已 /init enable」成立时补扫一次，成功才记
 * sweptAt——把边沿消耗在投递那一刻、而不是落地那一刻，一次限流失败就等于
 * 那些人永久坐在群里（见 infra/blocklist/）。失败后的重试挂在管理员身份
 * 观测上，而那类更新每条入群都会来一次，因此必须有 nextRetryAt 这道闸。
 *
 * sweptAt 一旦写下就是个闩锁，只有两条路径能打开：停管后重新接管，或
 * infra/blocklist/ 的 requestBlocklistResweep 显式请求重扫。后者是 `/block`
 * 某个群封禁失败、秒踢批次没落定这类「这个群里还留着人」的信号——没有它，
 * 那个人就在那个群里待到进程结束。
 *
 * 生命周期：投递时写入，回执时更新；群被 /init disable、机器人被撤管理员或
 * 移出群时由 infra/blocklist/ 的 forgetChatBlocklistWork 连同在途批次一起
 * 清掉，重新接管后照常再欠一次。
 * 容量按「本进程见过的管理员群」计，随停管即时释放。
 */
export const blocklistSweepState: Map<number, BlocklistSweepRecord> = new Map();

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
};

/**
 * 群不再由本机器人看管：丢掉补扫进度，重新接管后重新欠一次。
 * 纯状态操作——在途批次的丢弃是业务判定，收在 infra/blocklist/ 的
 * forgetChatBlocklistWork 里，调用方一律用那个（cache 层不写业务逻辑）。
 */
export function clearBlocklistSweepState(chatId: number): void {
  blocklistSweepState.delete(chatId);
}

/** 未注册时的显式 no-op：没有 owner 就没人能执行处置，因此投出去的条数恒为 0。 */
const noBlockedMemberRemover: BlockedMemberRemover = (): Promise<number> => Promise.resolve(0);

/**
 * 黑名单处置的执行 owner（入群守卫代理 packages/antiRaid/blocklistGuard.ts 在启动时
 * 反向注册）。单槽位，不随聊天或事件增长；infra 侧只经它分发，不静态依赖
 * Anti-Raid 业务模块（见 docs/cn/04-invariants.md 的 owner 约束）。
 */
export const blockedMemberRemoverHolder: { current: BlockedMemberRemover } = {
  current: noBlockedMemberRemover,
};
