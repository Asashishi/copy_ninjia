import { emergencyLockdownRecoveryRuntime } from "../../cache/main/antiRaid/lockdownMirror";
import { antiRaidBarrier, antiRaidRuntimeState } from "../../cache/main/antiRaid/proxy";
import {
  activeVerificationSnapshots,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
} from "../../cache/main/antiRaid/verificationMirror";
import { VERIFICATION_RECORD_CAPACITY } from "../../consts/antiRaid/verification";
import {
  postDiskIO,
} from "../../infra/diskIO";
import { prefetchIdentityPolicies } from "../../infra/identityStorage";
import { logger } from "../../infra/logger";
import { replayPendingBlockedRemovals } from "../../infra/blocklist/sweep";
import { superviseDuplexWorker } from "../../infra/supervisedDuplexWorker";
import type { SupervisedWorkerHandle } from "../../infra/supervisedWorker";
import {
  handleAntiRaidWorkerTelegramRequest,
  telegramWorkerResponseTransfer,
} from "../../infra/telegram/workerRequests";
import { WorkerUndeliveredError } from "../../libs/workerDelivery";
import type {
  AdoptableLockdown,
  AdoptLockdownsMessage,
  AntiRaidWorkerMessage,
  AntiRaidWorkerRequest,
} from "../../types/antiRaid/protocol";
import type { AntiRaidWorkerEvent } from "../../types/antiRaid/events";
import type { VerificationSnapshot } from
  "../../types/antiRaid/verification";
import type { WorkerDuplexInbound } from "../../types/workerDuplex";
import {
  buildAdoptLockdownsMessage,
  recoverAbandonedLockdowns,
  seedPersistedLockdownFingerprints,
  stopEmergencyLockdownRecoveries,
} from "../lockdownMirror";
import {
  advanceDeferredVerificationGeneration,
  deleteDeferredVerificationsForChat,
  grantVerificationAttempt,
  resetVerificationAttemptRuntime,
} from "../verificationAttempts";
import { canBypassAdDetection } from "../memberFacts";
import { handleAntiRaidWorkerEvent } from "./events";
import { registerAntiRaidBridgeObservers } from "./observers";
import {
  advanceActiveVerificationGeneration,
  buildAdoptVerificationsMessage,
  nextAntiRaidGeneration,
  purgeDisabledJoinGuards,
  replayAdDetectAgentConfig,
  replayBotPermissions,
  replayChatKinds,
} from "./replay";

/**
 * Anti-Raid 主线程控制器：只负责 Worker 生命周期、代际切换和公开控制命令。
 * 事件归并、重放数据构建及外部观察者注册分别位于同目录的叶子模块。
 */

/** Anti-Raid 专属进程级许可与 Telegram 能力共用既有双工边界。 */
async function handleAntiRaidWorkerRequest(
  request: AntiRaidWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (request.operation === "verificationAttemptPermit") {
    return grantVerificationAttempt(request);
  }
  if (request.operation === "sendTemporaryMessage") {
    // 引用警告晚于候选入队和模型判定；发送前必须以主线程当前权限为准。
    // 冷读失败时不拿未知身份冒充无豁免，避免错误警告或删除临时成员消息。
    const prefetched: boolean = await prefetchIdentityPolicies([request.identityId]);
    if (
      !prefetched ||
      canBypassAdDetection(request.identityId)
    ) return { suppressed: true };
  }
  return handleAntiRaidWorkerTelegramRequest(request, signal);
}

function antiRaidWorkerResponseTransfer(
  request: AntiRaidWorkerRequest,
  value: unknown
): Bun.Transferable[] | undefined {
  if (request.operation === "verificationAttemptPermit") return undefined;
  return telegramWorkerResponseTransfer(request, value);
}

const {
  init: initAntiRaidWorker,
  post,
  terminate: terminateAntiRaidWorker,
}: SupervisedWorkerHandle<WorkerDuplexInbound<AntiRaidWorkerMessage>> =
  superviseDuplexWorker<
    AntiRaidWorkerMessage,
    AntiRaidWorkerEvent,
    AntiRaidWorkerRequest
  >({
    url: new URL("../../workers/antiRaidWorker.ts", import.meta.url).href,
    label: "Anti-raid guard Worker",
    giveUpConsequence:
      "join verification and anti-raid features will silently stay disabled until the process restarts.",
    handleRequest: handleAntiRaidWorkerRequest,
    responseTransfer: antiRaidWorkerResponseTransfer,
    onEvent: (event: AntiRaidWorkerEvent): void => {
      handleAntiRaidWorkerEvent(event, postAntiRaidOrThrow);
    },
    onRespawn: (
      postToNext: (message: AntiRaidWorkerMessage) => boolean
    ): void => {
      antiRaidBarrier.settleAll("failed");
      const generation: number = nextAntiRaidGeneration();
      advanceDeferredVerificationGeneration(generation);
      advanceActiveVerificationGeneration(generation);

      // FIFO：配置、权限与群类型必须先于所有接管快照和新业务消息。
      if (!replayAdDetectAgentConfig(postToNext)) return;
      if (!replayBotPermissions(postToNext)) return;
      if (!replayChatKinds(postToNext)) return;
      if (!postToNext(buildAdoptVerificationsMessage(generation))) return;

      for (const [key, record] of activeVerificationSnapshots) {
        if (
          record.phase !== "kickPending" &&
          record.phase !== "checkingInviter" &&
          record.phase !== "expelling"
        ) continue;
        const persisted: { generation: number; revision: number } | undefined =
          persistedVerificationRevisions.get(key);
        if (
          persisted?.generation === record.generation &&
          persisted.revision === record.revision
        ) {
          if (!postToNext({
            type: "verificationPersisted",
            key,
            generation,
            revision: record.revision,
          })) return;
        } else {
          postDiskIO({
            type: "verificationUpsert",
            record: { ...record, generation },
            critical: true,
          });
        }
      }

      const adopt: AdoptLockdownsMessage = buildAdoptLockdownsMessage();
      if (adopt.lockdowns.length > 0 && !postToNext(adopt)) {
        logger.error("Anti-Raid Worker lockdown replay was rejected.");
      }
      purgeDisabledJoinGuards(postToNext);
      replayPendingBlockedRemovals();
    },
    onGiveUp: (): void => {
      antiRaidBarrier.settleAll("failed");
      recoverAbandonedLockdowns();
    },
  });

registerAntiRaidBridgeObservers({
  post,
  deactivateChat: deactivateAntiRaidChat,
});

/** 尽力把一条消息投给当前代际的 Anti-Raid Worker。 */
export function postAntiRaid(message: AntiRaidWorkerMessage): boolean {
  return post(message);
}

function postAntiRaidOrThrow(message: AntiRaidWorkerMessage): void {
  if (post(message)) return;
  throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
}

/**
 * 把持久化镜像接管给 Worker。调用点必须早于 runner 投递首条 update，确保 FIFO
 * 中配置与 adopt 均排在新业务消息之前。
 */
export function initAntiRaid(): void {
  if (antiRaidRuntimeState.initialized) return;
  antiRaidRuntimeState.initialized = true;
  antiRaidRuntimeState.persistenceVersion = 0;
  emergencyLockdownRecoveryRuntime.stopped = false;
  seedPersistedLockdownFingerprints();
  const generation: number = nextAntiRaidGeneration();
  advanceActiveVerificationGeneration(generation);
  try {
    initAntiRaidWorker();
    if (!replayAdDetectAgentConfig(post)) {
      throw new WorkerUndeliveredError(
        "Anti-Raid Worker rejected the agent configuration snapshot."
      );
    }
    replayBotPermissions(post);
    replayChatKinds(post);
    postAntiRaidOrThrow(buildAdoptVerificationsMessage(generation, true));
    replayPendingBlockedRemovals(false);
    const adopt: AdoptLockdownsMessage = buildAdoptLockdownsMessage();
    if (adopt.lockdowns.length > 0) {
      postAntiRaidOrThrow(adopt);
      logger.log(
        "Adopted lockdowns still active from previous process exit: " +
        adopt.lockdowns
          .map((lockdown: AdoptableLockdown): number => lockdown.chatId)
          .join(", ")
      );
    }
    // 必须先 adopt 再拆残留，确保 Worker 发出持久化 tombstone。
    purgeDisabledJoinGuards(post);
  } catch (error: unknown) {
    antiRaidRuntimeState.initialized = false;
    stopEmergencyLockdownRecoveries();
    throw error;
  }
}

/** 统一群 teardown：取消验证并对 lockdown 发起可恢复解锁。 */
export function deactivateAntiRaidChat(
  chatId: number,
  cleanupVerificationMessages: boolean
): void {
  deleteDeferredVerificationsForChat(chatId);
  postAntiRaidOrThrow({
    type: "deactivateChat",
    chatId,
    cleanupVerificationMessages,
  });
}

/** `/antiraid disable` 只收掉入群验证与 lockdown 链路。 */
export function deactivateJoinGuardChat(chatId: number): void {
  deleteDeferredVerificationsForChat(chatId);
  postAntiRaidOrThrow({ type: "deactivateJoinGuard", chatId });
}

/** `/ad_detect disable` 丢掉该群已经排进 Worker 的候选消息。 */
export function clearAdDetection(chatId: number): void {
  postAntiRaidOrThrow({ type: "clearAdDetect", chatId });
}

/** `/flood_control disable` 丢掉该群全部发言窗口。 */
export function clearFloodControl(chatId: number): void {
  postAntiRaidOrThrow({ type: "clearFloodControl", chatId });
}

/** 停机时终止 Worker；验证与 lockdown 的 write-ahead 镜像仍由主线程持有。 */
export async function terminateAntiRaid(): Promise<void> {
  antiRaidBarrier.settleAll("failed");
  antiRaidRuntimeState.initialized = false;
  stopEmergencyLockdownRecoveries();
  await terminateAntiRaidWorker();
  resetVerificationAttemptRuntime();
}

/** Disk I/O 恢复完成后、Anti-Raid 初始化前灌入主线程验证镜像。 */
export function hydratePendingVerifications(
  records: Map<string, VerificationSnapshot>
): void {
  if (antiRaidRuntimeState.initialized) {
    throw new Error(
      "Pending verifications must be hydrated before Anti-Raid initialization."
    );
  }
  if (records.size > VERIFICATION_RECORD_CAPACITY) {
    throw new Error(
      `Pending verification recovery exceeded the ${VERIFICATION_RECORD_CAPACITY}-record capacity.`
    );
  }
  activeVerificationSnapshots.clear();
  pendingVerificationDeletes.clear();
  persistedVerificationRevisions.clear();
  resetVerificationAttemptRuntime();
  for (const [key, record] of records) {
    activeVerificationSnapshots.set(key, {
      ...record,
      trackedMessageTimes: [...record.trackedMessageTimes],
    });
    persistedVerificationRevisions.set(key, {
      generation: record.generation,
      revision: record.revision,
    });
  }
}
