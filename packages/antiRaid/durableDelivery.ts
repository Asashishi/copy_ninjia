import { logger } from "../infra/logger";
import {
  flushStateToDisk,
} from "../infra/storage/stateStore";
import {
  ANTI_RAID_BARRIER_TIMEOUT_MS,
  ANTI_RAID_DRAIN_MAX_ROUNDS,
} from "../consts/antiRaid/protocol";
import { flushDiskIO } from "../infra/diskIO";
import { WorkerUndeliveredError } from "../libs/workerDelivery";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../libs/monotonicDeadline";
import { antiRaidBarrier, antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import { drainAdDisposals } from "./adDetect";
import { registerBlocklistRemoval } from "./blocklistGuard";
import { prepareDurableAntiRaidMessages } from "./blocklistDelivery";
import { postAntiRaid } from "./workerBridge";
import type { FlushResult } from "../types/lifecycle";
import type { AntiRaidWorkerMessage } from "../types/antiRaid";

/** FIFO mailbox barrier：只证明此前消息已同步路由，不等待后台网络副作用。 */
function barrierAntiRaidMailbox(
  timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS
): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return Promise.resolve("flushed");
  return antiRaidBarrier.begin(
    (barrierId: number): boolean => postAntiRaid({ type: "barrier", barrierId }),
    timeoutMs
  );
}

/** 等待 Worker 此前启动的异步副作用全部结算，不处理跨线程持久化握手。 */
function drainAntiRaidWorkerTasks(timeoutMs: number): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return Promise.resolve("flushed");
  return antiRaidBarrier.begin(
    (drainId: number): boolean => postAntiRaid({ type: "drain", drainId }),
    timeoutMs
  );
}

function remainingDrainTime(deadline: number): number {
  return remainingMonotonicTime(deadline);
}

/**
 * 停机排空：先 quiesce Worker 广告判定并取得 FIFO drain 回执，再等待主线程
 * 广告处置；随后让已有镜像落盘并把持久化回执交回 Worker，等待由回执放行的
 * 网络副作用。若副作用又发布了新镜像则重复，直到固定点或达到轮数上限。
 */
export async function drainAntiRaid(
  timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS
): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return "flushed";
  const deadline: number = createMonotonicDeadline(timeoutMs);
  // Worker 在处理 drain 时先关闭广告判定节拍；同一端口 FIFO 保证更早发布的
  // adDetected 已先在主线程登记，回执之后在途判定因 stopping 门禁不再发布。
  // 因此只有拿到这道回执后，inFlightAdDisposals 的第一次快照才是稳定边界。
  const quiesceResult: FlushResult =
    await drainAntiRaidWorkerTasks(remainingDrainTime(deadline));
  if (quiesceResult !== "flushed") {
    // 回执拿不到（Worker 已放弃或正在重生）时，主线程侧仍可能有处置卡在
    // confirmBlocklistPersisted 上——那正是「拉黑已入队、还没落盘」的窗口，
    // 直接 return 会连同待写的黑名单一起丢掉。因此用剩余预算再排空一次；
    // 没有回执就没有稳定边界，这一轮只覆盖此刻在途的那批，属尽力而为，
    // 结果不改写返回值：失败原因仍是 quiesce 本身。
    await drainAdDisposals(remainingDrainTime(deadline));
    return quiesceResult;
  }
  for (let round: number = 0; round < ANTI_RAID_DRAIN_MAX_ROUNDS; round++) {
    // 广告判定命中后的主线程处置（拉黑落盘 + 登记封禁批次）收进本轮对账：
    // 它自己会再投一次 removeBlockedMembers，落在下面的 barrier 与 flush 之前。
    // 与本轮其余每一步一样吃同一份剩余预算——裸等的话，预算为 0 的异常退出
    // 路径会被它一路拖到强制退出线（见 adDetect.ts 的 drainAdDisposals）。
    const disposalResult: FlushResult =
      await drainAdDisposals(remainingDrainTime(deadline));
    if (disposalResult !== "flushed") return disposalResult;
    const initialBarrier: FlushResult =
      await barrierAntiRaidMailbox(remainingDrainTime(deadline));
    if (initialBarrier !== "flushed") return initialBarrier;

    const persistenceResults: [
      PromiseSettledResult<FlushResult>,
      PromiseSettledResult<FlushResult>
    ] = await Promise.allSettled([
      flushDiskIO(remainingDrainTime(deadline)),
      flushStateToDisk(remainingDrainTime(deadline)),
    ]);
    if (persistenceResults.some(
      (result: PromiseSettledResult<FlushResult>): boolean =>
        result.status === "rejected"
    )) {
      return "failed";
    }
    const diskResult: FlushResult =
      (persistenceResults[0] as PromiseFulfilledResult<FlushResult>).value;
    const stateResult: FlushResult =
      (persistenceResults[1] as PromiseFulfilledResult<FlushResult>).value;
    if (diskResult !== "flushed") return diskResult;
    if (stateResult !== "flushed") return stateResult;

    // flush 回执本身会投回 Worker 并启动下一阶段副作用；第二道 FIFO barrier
    // 确保这些消息已路由，随后才能对真实在途任务做 drain。
    const receiptBarrier: FlushResult =
      await barrierAntiRaidMailbox(remainingDrainTime(deadline));
    if (receiptBarrier !== "flushed") return receiptBarrier;
    const persistenceVersionBeforeTasks: number =
      antiRaidRuntimeState.persistenceVersion;
    const taskResult: FlushResult =
      await drainAntiRaidWorkerTasks(remainingDrainTime(deadline));
    if (taskResult !== "flushed") return taskResult;
    if (
      antiRaidRuntimeState.persistenceVersion ===
      persistenceVersionBeforeTasks
    ) {
      return "flushed";
    }
  }
  logger.error(
    `Anti-Raid drain did not converge after ${ANTI_RAID_DRAIN_MAX_ROUNDS} persistence rounds.`
  );
  return "failed";
}

/**
 * update 安全交接：处理 mailbox 后，仅在镜像变化时同步两类持久化 owner。
 * @returns 真正投给 Worker 的消息条数。durable 对账可能把整批
 *   removeBlockedMembers 扣下（见 prepareDurableAntiRaidMessages），此时本函数
 *   正常 resolve 但一条都没投出去——调用方若把「没抛错」当成「已投递」就会
 *   永久卡住自己的 claim，理由见 types/blocklist.ts 的 BlockedMemberRemover。
 */
export async function postAntiRaidDurably(
  messages: readonly AntiRaidWorkerMessage[],
  replacedJoins: ReadonlyMap<number, AntiRaidWorkerMessage> = new Map(),
  timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS
): Promise<number> {
  let messagesToPost: readonly AntiRaidWorkerMessage[] = messages;
  if (messages.some(
    (message: AntiRaidWorkerMessage): boolean =>
      message.type === "removeBlockedMembers"
  )) {
    // 黑名单处置是安全副作用：update 被确认前先把主线程镜像写入持久化 outbox。
    // mailbox barrier 只证明 Worker 收到消息，不能替代跨进程恢复能力。
    messagesToPost = await prepareDurableAntiRaidMessages(
      messages,
      replacedJoins
    );
  }
  if (messagesToPost.length === 0) return 0;
  const postedCount: number = messagesToPost.length;
  const persistenceVersionBefore: number =
    antiRaidRuntimeState.persistenceVersion;
  for (const message of messagesToPost) {
    // 只有这一条路径代表「Worker 压根没收到」。下面的屏障失败与落盘失败都
    // 意味着它已经收下并在后台执行；两者仍要保留 durable 镜像，但错误类型
    // 必须可区分，供调用方判断本次是否可能已启动副作用（见 workerDelivery.ts）。
    if (!postAntiRaid(message)) {
      throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
    }
  }
  const barrierResult: FlushResult =
    await barrierAntiRaidMailbox(timeoutMs);
  if (barrierResult !== "flushed") {
    throw new Error(`Anti-Raid Worker barrier ${barrierResult}.`);
  }
  if (
    antiRaidRuntimeState.persistenceVersion === persistenceVersionBefore
  ) {
    return postedCount;
  }
  const persistenceResults: [
    PromiseSettledResult<FlushResult>,
    PromiseSettledResult<FlushResult>
  ] = await Promise.allSettled([
    flushDiskIO(timeoutMs),
    flushStateToDisk(timeoutMs),
  ]);
  const failures: unknown[] = persistenceResults
    .filter(
      (
        result: PromiseSettledResult<FlushResult>
      ): result is PromiseRejectedResult => result.status === "rejected"
    )
    .map(
      (result: PromiseRejectedResult): unknown =>
        result.reason as unknown
    );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Anti-Raid persistence boundary rejected."
    );
  }
  const diskResult: FlushResult =
    (persistenceResults[0] as PromiseFulfilledResult<FlushResult>).value;
  const stateResult: FlushResult =
    (persistenceResults[1] as PromiseFulfilledResult<FlushResult>).value;
  if (diskResult !== "flushed" || stateResult !== "flushed") {
    throw new Error(
      `Anti-Raid persistence failed: disk=${diskResult}, state=${stateResult}.`
    );
  }
  return postedCount;
}

// 黑名单清扫的执行 owner（判定在 infra/blocklist/，执行在 Worker）。
registerBlocklistRemoval(postAntiRaidDurably);
