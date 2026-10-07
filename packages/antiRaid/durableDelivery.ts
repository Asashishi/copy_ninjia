import { logger } from "../infra/logger";
import {
  flushStateToDisk,
} from "../infra/storage/stateStore";
import {
  ANTI_RAID_BARRIER_TIMEOUT_MS,
  ANTI_RAID_DRAIN_TIMEOUT_MS,
  ANTI_RAID_DRAIN_MAX_ROUNDS,
} from "../consts/antiRaid/protocol";
import { flushDiskIO, flushDiskIODomain } from "../infra/diskIO";
import { WorkerUndeliveredError } from "../libs/workerDelivery";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../libs/monotonicDeadline";
import { antiRaidBarrier, antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import { drainAdDisposals } from "./adDetect";
import { registerBlocklistRemoval } from "./blocklistGuard";
import { prepareDurableAntiRaidMessages } from "./blocklistDelivery";
import { postAntiRaid } from "./workerBridge/controller";
import type { FlushResult } from "../types/lifecycle";
import type { AntiRaidWorkerMessage } from "../types/antiRaid/protocol";

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

/**
 * 停机排空：先 quiesce Worker 广告判定并取得 FIFO drain 回执，再等待主线程
 * 广告处置；随后让已有镜像落盘并把持久化回执交回 Worker，等待由回执放行的
 * 网络副作用。若副作用又发布了新镜像则重复，直到固定点或达到轮数上限。
 */
export async function drainAntiRaid(
  timeoutMs: number = ANTI_RAID_DRAIN_TIMEOUT_MS
): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return "flushed";
  const deadline: number = createMonotonicDeadline(timeoutMs);
  // Worker 在处理 drain 时先关闭广告判定节拍；同一端口 FIFO 保证更早发布的
  // adDetected 已先在主线程登记，回执之后在途判定因 stopping 门禁不再发布。
  // 因此只有拿到这道回执后，inFlightAdDisposals 的第一次快照才是稳定边界。
  const quiesceResult: FlushResult =
    await drainAntiRaidWorkerTasks(remainingMonotonicTime(deadline));
  if (quiesceResult !== "flushed") {
    // 回执拿不到（Worker 已放弃或正在重生）时，用剩余预算再排空一次主线程在途处置；
    // 没有回执就没有稳定边界，这一轮只覆盖此刻在途的那批，结果不改写返回值，
    // 返回的仍是 quiesce 本身的结果。
    await drainAdDisposals(remainingMonotonicTime(deadline));
    return quiesceResult;
  }
  for (let round: number = 0; round < ANTI_RAID_DRAIN_MAX_ROUNDS; round++) {
    // 广告判定命中后的主线程处置（拉黑落盘 + 登记封禁批次）收进本轮对账：
    // 它会再投一次 removeBlockedMembers，落在下面的 barrier 与 flush 之前；
    // 与本轮其余每一步共用同一份剩余预算（见 adDetect.ts 的 drainAdDisposals）。
    const disposalResult: FlushResult =
      await drainAdDisposals(remainingMonotonicTime(deadline));
    if (disposalResult !== "flushed") return disposalResult;
    const initialBarrier: FlushResult =
      await barrierAntiRaidMailbox(remainingMonotonicTime(deadline));
    if (initialBarrier !== "flushed") return initialBarrier;

    // 预算先取一次再进两个 flush：两者都把非正预算当成参数错误
    // （flushDiskIO 是 async 拒绝，flushStateToDisk 是同步 throw）；
    // 零预算与本函数其余各步同口径，返回 timedOut。
    const persistenceBudget: number = remainingMonotonicTime(deadline);
    if (persistenceBudget === 0) return "timedOut";
    const persistenceResults: [
      PromiseSettledResult<FlushResult>,
      PromiseSettledResult<FlushResult>
    ] = await Promise.allSettled([
      flushDiskIO(persistenceBudget),
      flushStateToDisk(persistenceBudget, false),
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
      await barrierAntiRaidMailbox(remainingMonotonicTime(deadline));
    if (receiptBarrier !== "flushed") return receiptBarrier;
    const verificationVersionBeforeTasks: number =
      antiRaidRuntimeState.verificationVersion;
    const lockdownVersionBeforeTasks: number =
      antiRaidRuntimeState.lockdownVersion;
    const taskResult: FlushResult =
      await drainAntiRaidWorkerTasks(remainingMonotonicTime(deadline));
    if (taskResult !== "flushed") return taskResult;
    if (
      antiRaidRuntimeState.verificationVersion === verificationVersionBeforeTasks &&
      antiRaidRuntimeState.lockdownVersion === lockdownVersionBeforeTasks
    ) {
      return "flushed";
    }
  }
  logger.error(
    `Anti-Raid drain did not converge after ${ANTI_RAID_DRAIN_MAX_ROUNDS} persistence rounds.`
  );
  return "failed";
}

/** 本批是否含黑名单处置（removeBlockedMembers）；含时先经 durable 对账再投递。 */
function containsBlockedRemoval(messages: readonly AntiRaidWorkerMessage[]): boolean {
  for (const message of messages) {
    if (message.type === "removeBlockedMembers") return true;
  }
  return false;
}

/** 本次 durable 投递期间哪些 Anti-Raid 镜像发生了变化。 */
interface ChangedAntiRaidMirrors {
  readonly verification: boolean;
  readonly lockdown: boolean;
}

/**
 * Anti-Raid 镜像的领域落盘屏障：待验证镜像在 `verification` 领域，锁定记录随群状态
 * 在共享 SQLite 的 `chatState` 领域。只刷发生变化的那一格（`chatState` 屏障会提交
 * 整个共享 SQLite 事务）；停机排空仍走统一 flush（见 drainAntiRaid）。
 * 未变化的领域按已刷新结算。
 */
function flushAntiRaidMirrors(
  changed: ChangedAntiRaidMirrors,
  timeoutMs: number
): Promise<[PromiseSettledResult<FlushResult>, PromiseSettledResult<FlushResult>]> {
  return Promise.allSettled([
    changed.verification ? flushDiskIODomain("verification", timeoutMs) : "flushed",
    changed.lockdown ? flushDiskIODomain("chatState", timeoutMs) : "flushed",
  ]);
}

/**
 * update 安全交接：处理 mailbox 后，仅为变化过的 Anti-Raid 镜像经对应领域屏障落盘。
 * @returns 真正投给 Worker 的消息条数。durable 对账可能把整批
 *   removeBlockedMembers 扣下（见 prepareDurableAntiRaidMessages），此时本函数
 *   正常 resolve，返回值小于 messages.length（可为 0），见 types/blocklist.ts 的
 *   BlockedMemberRemover。
 */
export async function postAntiRaidDurably(
  messages: readonly AntiRaidWorkerMessage[],
  replacedJoins?: ReadonlyMap<number, AntiRaidWorkerMessage>
): Promise<number> {
  let messagesToPost: readonly AntiRaidWorkerMessage[] = messages;
  if (containsBlockedRemoval(messages)) {
    // 黑名单处置是安全副作用：update 被确认前先把主线程镜像写入持久化 outbox。
    // mailbox barrier 只证明 Worker 收到消息，不能替代跨进程恢复能力。
    messagesToPost = await prepareDurableAntiRaidMessages(
      messages,
      replacedJoins
    );
  }
  if (messagesToPost.length === 0) return 0;
  const postedCount: number = messagesToPost.length;
  const verificationVersionBefore: number = antiRaidRuntimeState.verificationVersion;
  const lockdownVersionBefore: number = antiRaidRuntimeState.lockdownVersion;
  for (const message of messagesToPost) {
    // 只有这一条路径抛 WorkerUndeliveredError（Worker 没收到）；下面的屏障失败与
    // 落盘失败表示 Worker 已收下并在后台执行，抛普通 Error，供调用方区分
    // 本次是否可能已启动副作用（见 libs/workerDelivery.ts）。
    if (!postAntiRaid(message)) {
      throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
    }
  }
  const barrierResult: FlushResult =
    await barrierAntiRaidMailbox(ANTI_RAID_BARRIER_TIMEOUT_MS);
  if (barrierResult !== "flushed") {
    throw new Error(`Anti-Raid Worker barrier ${barrierResult}.`);
  }
  const changed: ChangedAntiRaidMirrors = {
    verification: antiRaidRuntimeState.verificationVersion !== verificationVersionBefore,
    lockdown: antiRaidRuntimeState.lockdownVersion !== lockdownVersionBefore,
  };
  if (!changed.verification && !changed.lockdown) return postedCount;
  const persistenceResults: [
    PromiseSettledResult<FlushResult>,
    PromiseSettledResult<FlushResult>
  ] = await flushAntiRaidMirrors(changed, ANTI_RAID_BARRIER_TIMEOUT_MS);
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
  const verificationResult: FlushResult =
    (persistenceResults[0] as PromiseFulfilledResult<FlushResult>).value;
  const chatStateResult: FlushResult =
    (persistenceResults[1] as PromiseFulfilledResult<FlushResult>).value;
  if (verificationResult !== "flushed" || chatStateResult !== "flushed") {
    throw new Error(
      `Anti-Raid persistence failed: verification=${verificationResult}, chatState=${chatStateResult}.`
    );
  }
  return postedCount;
}

// 黑名单清扫的执行 owner（判定在 infra/blocklist/，执行在 Worker）。
registerBlocklistRemoval(postAntiRaidDurably);
