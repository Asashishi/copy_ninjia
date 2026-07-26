import type { BlockedMemberRemover, PendingBlockedRemoval } from "../types/blocklist";
import type { BlockedUserRecord } from "../types/diskIO/storage";

/** 黑名单查询（packages/infra/blocklist.ts）的主线程侧内存状态。 */

/**
 * 已被 /block 拉黑的用户 id → 文件里那条完整记录。
 *
 * value 存整条记录而不是 true，是 `/unblock` 的前提：黑名单文件是追加型的，
 * 删不掉已有条目，解除拉黑只能把删除之后的这份 Map 整份重写回文件。若这里
 * 只留「在不在」，重写就会把名单里其他人的 blockedAt 一起抹平——因此读回来
 * 的结构必须是完整的（见 workers/diskIO/blocklistFile.ts 的 decodeBlocklist）。
 * 判定路径只用 has()，多存的那点文本不进热路径。
 *
 * 生命周期：启动时由 app/lifecycle.ts 用 diskIOWorker 读回的黑名单文件一次性
 * 灌入（hydrateBlocklist），此后由 /block 增量写入、`/unblock` 删除——都是
 * 先更新本 Map，再投递落盘消息，因此内存永远不落后于磁盘，且本 Map 始终是
 * 名单的权威副本。进程重启后从文件重建；diskIOWorker 崩溃重启不影响本 Map
 * （它是主线程状态，丢失的增量由 infra/blocklist.ts 的 respawn 重放补齐）。
 * 容量随拉黑次数增长，只有 `/unblock` 会让它变小。
 */
export const blockedUserIds: Map<number, BlockedUserRecord> = new Map();

/**
 * 本进程启动之后新拉黑的 id → 其 blockedAt 文本。只为 diskIOWorker 崩溃重建后
 * 的重放：新 Worker 会先从文件重新 hydrate，已在文件里的 id 由它自己去重，
 * 因此只需补投「本进程期间产生、可能还没落盘」的这批。启动时 hydrate 进来的
 * 那些本来就来自文件，不进这里，重放量因此与黑名单总量无关。
 */
export const sessionBlockedAt: Map<number, string> = new Map();

/**
 * 本进程启动之后被 `/unblock` 解除的 id。追加型文件补不回「删除」，所以
 * diskIOWorker 崩溃重建后不能只补投这些增量——只要这个集合非空，就必须整份
 * 重写一次文件（见 infra/blocklist.ts 的 onDiskIORespawn）。
 *
 * 与 sessionBlockedAt 互斥：拉黑时从这里删、解除时往这里加，否则同一个 id
 * 同时出现在两张表里，重放顺序就决定了他到底在不在名单上。
 * 容量按本进程的解除次数计，`/unblock` 是极低频的人工操作。
 */
export const sessionUnblockedIds: Set<number> = new Set();

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
 * 于 Telegram update 重投的恢复边界（见 infra/blocklist.ts）。
 *
 * Worker 崩溃重建时整表重投——处置是纯副作用，重复 ban 幂等，漏掉却意味着
 * 那个人一直坐在群里。容量由 BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES 硬顶背压；
 * attempts 只用于持久化诊断，达到告警阈值也不能销毁安全任务。
 */
export const pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();

/** 处置批次编号发号器；只在主线程自增，用于回执对账。 */
export const blocklistRemovalCounter: { current: number } = { current: 0 };

/** 单个群的补扫进度。 */
export interface BlocklistSweepRecord {
  /** 在途批次的编号；null 表示当前没有批次在跑。 */
  removalId: number | null;
  /** 已完整扫过一次的时刻；null 表示还没扫成功过，仍欠这个群一次。 */
  sweptAt: number | null;
  /** 上一次没能全部落定后，允许再试的最早时刻。 */
  nextRetryAt: number;
  /**
   * 在途批次落定后必须立刻再欠一次（`/block` 在本群封禁失败、或秒踢批次没
   * 落定）。用显式标志而不是直接把 sweptAt 置 null，是为了不跟在途批次抢写：
   * 那批的 `complete: true` 回执若晚于重扫请求到达，会把 sweptAt 写回去，
   * 重扫请求就这么丢了（见 infra/blocklist.ts 的 settleBlockedRemoval）。
   */
  resweepRequested: boolean;
}

/**
 * 各群的补扫进度。「是管理员 && 已 /init enable」成立时补扫一次，成功才记
 * sweptAt——把边沿消耗在投递那一刻、而不是落地那一刻，一次限流失败就等于
 * 那些人永久坐在群里（见 infra/blocklist.ts）。失败后的重试挂在管理员身份
 * 观测上，而那类更新每条入群都会来一次，因此必须有 nextRetryAt 这道闸。
 *
 * sweptAt 一旦写下就是个闩锁，只有两条路径能打开：停管后重新接管，或
 * infra/blocklist.ts 的 requestBlocklistResweep 显式请求重扫。后者是 `/block`
 * 某个群封禁失败、秒踢批次没落定这类「这个群里还留着人」的信号——没有它，
 * 那个人就在那个群里待到进程结束。
 *
 * 生命周期：投递时写入，回执时更新；群被 /init disable、机器人被撤管理员或
 * 移出群时由 infra/blocklist.ts 的 forgetChatBlocklistWork 连同在途批次一起
 * 清掉，重新接管后照常再欠一次。
 * 容量按「本进程见过的管理员群」计，随停管即时释放。
 */
export const blocklistSweepState: Map<number, BlocklistSweepRecord> = new Map();

/**
 * 群不再由本机器人看管：丢掉补扫进度，重新接管后重新欠一次。
 * 纯状态操作——在途批次的丢弃是业务判定，收在 infra/blocklist.ts 的
 * forgetChatBlocklistWork 里，调用方一律用那个（cache 层不写业务逻辑）。
 */
export function clearBlocklistSweepState(chatId: number): void {
  blocklistSweepState.delete(chatId);
}

/** 未注册时的显式 no-op：没有 owner 就没人能执行处置。 */
const noBlockedMemberRemover: BlockedMemberRemover = (): Promise<void> => Promise.resolve();

/**
 * 黑名单处置的执行 owner（入群守卫代理 packages/antiRaid/blocklistGuard.ts 在启动时
 * 反向注册）。单槽位，不随聊天或事件增长；infra 侧只经它分发，不静态依赖
 * Anti-Raid 业务模块（见 docs/04-invariants.md 的 owner 约束）。
 */
export const blockedMemberRemoverHolder: { current: BlockedMemberRemover } = {
  current: noBlockedMemberRemover,
};
