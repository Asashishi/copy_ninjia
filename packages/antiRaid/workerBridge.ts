import { logger } from "../infra/logger";
import {
  clearChatStateField,
  getAllChatStates,
  getOrCreateChatState,
  saveState,
  saveStateInBackground,
} from "../infra/storage/stateStore";
import {
  registerBotPermissionObserver,
} from "../infra/botAdmin";
import { botChatPermissions } from "../cache/main/botAdmin";
import type { BotChatPermissions } from "../types/telegram";
import { registerChatTeardown } from "../infra/chatTeardown";
import {
  LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS,
} from "../consts/antiRaid/protocol";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import { superviseWorker } from "../libs/supervisedWorker";
import { WorkerUndeliveredError } from "../libs/workerDelivery";
import {
  onDiskIORespawn,
  onVerificationPersisted,
  postDiskIO,
} from "../infra/diskIO";
import {
  buildAdoptLockdownsMessage,
  lockdownFingerprint,
  lockdownFingerprintMatches,
  recoverAbandonedLockdowns,
  seedPersistedLockdownFingerprints,
  stopEmergencyLockdownRecoveries,
} from "./lockdownMirror";
import {
  acceptVerificationDelete,
  acceptVerificationUpsert,
} from "./verificationMirror";
import { handleAdDetected } from "./adDetect";
import {
  replayPendingBlockedRemovals,
  settleBlockedRemoval,
} from "../infra/blocklist/sweep";
import { antiRaidBarrier, antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import {
  emergencyLockdownRecoveryRuntime,
  pendingLockdownPersistence,
  persistedLockdownFingerprints,
} from "../cache/main/antiRaid/lockdownMirror";
import {
  activeVerificationSnapshots,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
} from "../cache/main/antiRaid/verificationMirror";
import type {
  AdoptableLockdown,
  AdoptLockdownsMessage,
  AdoptVerificationsMessage,
  AntiRaidWorkerEvent,
  AntiRaidWorkerMessage,
  VerificationSnapshot,
} from "../types/antiRaid";
import type { PersistedLockdownFingerprint } from "../types/antiRaid/internal";
import type { LockdownRecord } from "../types/chatState";
import type { SupervisedWorkerHandle } from "../libs/supervisedWorker";
import type {
  DiskIORecoveryTransport,
  VerificationPersistedReply,
} from "../types/diskIO";

/**
 * 入群守卫 Worker 桥接（主线程侧代理）：入群验证 + 反刷群私密模式。真正的逻辑
 * ——验证窗口、超时踢人、按钮应答、入群计数、私密模式的触发/恢复、
 * 私密模式期间的删公告 + 踢人——全部在独立的 Bun Worker
 * （packages/workers/antiRaidWorker.ts）里执行；正常路径下主线程只从 grammY
 * 更新里提取出无状态的事件投递过去，不发起 Telegram API 调用，让更新
 * 调度不被入群守卫的突发 API 流量抢占。唯一例外是 Worker 耗尽重建预算
 * 后的紧急解锁：主线程只接管已经持久化在镜像里的邀请权限恢复。
 * postMessage 按 FIFO 送达，同一次入群「先 join、后 message/callback」的
 * 先后顺序在 Worker 侧保持不变。
 *
 * 主线程唯一持有的私密模式状态是各群 ChatState.lockdown 字段
 * （infra/storage/stateStore.ts 持有、随 state.json 持久化），业务判定一概
 * 不读它，只用于 Worker/进程重建时的 adopt 重放，以及 supervisor 放弃
 * 自愈后的主线程紧急恢复——权限限制已实际落在群上，恢复 owner 不能丢。
 *
 * Worker 的启动、崩溃自愈（含节流放弃）、日志转投见 libs/supervisedWorker.ts。
 * 待验证纯数据由主线程镜像并转投唯一 Disk I/O Worker 的当日增量 JSON：
 * Worker 或整个进程重建后都按 expiresAt 接管。私密模式仍由 state.json 恢复。
 */

function nextAntiRaidGeneration(): number {
  antiRaidRuntimeState.generation++;
  return antiRaidRuntimeState.generation;
}

function buildAdoptVerificationsMessage(generation: number, resumePersistedTerminals: boolean = false): AdoptVerificationsMessage {
  return { type: "adoptVerifications", generation, verifications: [...activeVerificationSnapshots.values()], resumePersistedTerminals };
}

/**
 * 把这个群当前的锁定意图写进 state.json，落定后回执给 Worker。
 *
 * 循环是「存下去 → 再看一眼还是不是同一份意图」的对账：不是就带着新意图重存
 * 一次。指纹只含 phase + intentId（见 cache/main/antiRaid/lockdownMirror.ts），因此重来一轮意味着
 * 状态机真的推进了一个阶段——事件驱动、次数有界。轮次上限只是兜底：万一将来
 * 有谁把一个高频变动的字段加回指纹，宁可这个群的握手停下并留一行错误日志，
 * 也不能让主线程陷在「每轮两次带 fsync 的整文件重写」里出不来。停下不是终局，
 * 下一条 lockdown 事件会重新进来。
 */
function persistCurrentLockdown(chatId: number): void {
  if (pendingLockdownPersistence.has(chatId)) return;
  pendingLockdownPersistence.add(chatId);
  void (async (): Promise<void> => {
    for (let round: number = 0; round < LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS; round++) {
      const expected: LockdownRecord | undefined = getAllChatStates().get(chatId)?.lockdown;
      if (expected === undefined) return;
      const expectedFingerprint: PersistedLockdownFingerprint = lockdownFingerprint(expected);
      await saveState();
      const current: LockdownRecord | undefined = getAllChatStates().get(chatId)?.lockdown;
      if (current === undefined) return;
      if (!lockdownFingerprintMatches(current, expectedFingerprint)) continue;
      persistedLockdownFingerprints.set(chatId, expectedFingerprint);
      postAntiRaidOrThrow({
        type: "lockdownPersisted",
        chatId,
        phase: expectedFingerprint.phase,
        intentId: expectedFingerprint.intentId,
      });
      return;
    }
    logger.error(
      `Anti-raid lockdown intent for chat ${chatId} kept changing across ` +
      `${LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS} durability rounds; giving up until the next lockdown event.`
    );
  })()
    .catch((error: unknown): void => {
      logger.error(`Failed to persist anti-raid lockdown intent for chat ${chatId}:`, error);
    })
    .finally((): void => {
      pendingLockdownPersistence.delete(chatId);
    });
}

const { init: initAntiRaidWorker, post, terminate: terminateAntiRaidWorker }: SupervisedWorkerHandle<AntiRaidWorkerMessage> = superviseWorker<AntiRaidWorkerMessage, AntiRaidWorkerEvent>({
  url: new URL("../workers/antiRaidWorker.ts", import.meta.url).href,
  label: "Anti-raid guard Worker",
  giveUpConsequence: "join verification and anti-raid features will silently stay disabled until the process restarts.",
  onEvent: (event: AntiRaidWorkerEvent): void => {
    switch (event.type) {
      case "lockdown": {
        const expected: LockdownRecord = {
          phase: event.phase,
          intentId: event.intentId,
          originalPermissions: event.originalPermissions,
          expiresAt: event.expiresAt,
        };
        getOrCreateChatState(event.chatId).lockdown = expected;
        persistedLockdownFingerprints.delete(event.chatId);
        persistCurrentLockdown(event.chatId);
        antiRaidRuntimeState.persistenceVersion++;
        break;
      }
      case "unlock": {
        persistedLockdownFingerprints.delete(event.chatId);
        if (clearChatStateField(event.chatId, "lockdown")) {
          saveStateInBackground("anti-raid unlock");
          antiRaidRuntimeState.persistenceVersion++;
        }
        break;
      }
      case "verificationUpsert":
        if (acceptVerificationUpsert(event)) antiRaidRuntimeState.persistenceVersion++;
        break;
      case "verificationDelete":
        if (acceptVerificationDelete(event)) antiRaidRuntimeState.persistenceVersion++;
        break;
      case "blockedMembersRemoved":
        settleBlockedRemoval(event);
        break;
      case "adDetected":
        handleAdDetected(event);
        break;
      case "barrierComplete": {
        antiRaidBarrier.settle(event.barrierId, "flushed");
        break;
      }
      case "drainComplete": {
        antiRaidBarrier.settle(event.drainId, "flushed");
        break;
      }
    }
  },
  // 崩溃的 Worker 带走了所有计时器；先用主线程待验证镜像重建验证，再把
  // 仍在生效的私密模式交给新 Worker。FIFO 保证两类 adopt 都先于新投递。
  onRespawn: (postToNext: (message: AntiRaidWorkerMessage) => boolean): void => {
    antiRaidBarrier.settleAll("failed");
    const generation: number = nextAntiRaidGeneration();
    for (const [key, record] of activeVerificationSnapshots) {
      const persisted: { generation: number; revision: number; } | undefined = persistedVerificationRevisions.get(key);
      activeVerificationSnapshots.set(key, { ...record, generation });
      if (persisted?.generation === record.generation && persisted.revision === record.revision) {
        persistedVerificationRevisions.set(key, { generation, revision: record.revision });
      }
    }
    // 权限镜像排在第一次投递：新 isolate 的那张表是空的，而空表按契约等于
    // 「什么都做不了」。FIFO 保证它先于随后的 adopt 与新到的刷屏计数生效。
    // **必须排在代际提升与快照重打之后**：那两步在原实现里是无条件执行的，
    // 提前 return 会让本次重生既没提升代际、也没重打快照，而 activeVerification-
    // Snapshots 仍带着旧 Worker 的代际——迟到事件的代际比对因此失去分辨力。
    if (!replayBotPermissions(postToNext)) return;
    if (!postToNext(buildAdoptVerificationsMessage(generation))) return;
    for (const [key, record] of activeVerificationSnapshots) {
      if (record.phase !== "checkingInviter" && record.phase !== "expelling") continue;
      const persisted: { generation: number; revision: number; } | undefined = persistedVerificationRevisions.get(key);
      if (persisted?.generation === record.generation && persisted.revision === record.revision) {
        if (!postToNext({ type: "verificationPersisted", key, generation, revision: record.revision })) return;
      } else {
        // 旧 Worker 可能在终态 upsert 发出后、落盘回执前崩溃；重新提交并等待
        // Disk I/O 的精确 revision 回执，绝不凭主线程镜像直接执行踢人。
        postDiskIO({ type: "verificationUpsert", record: { ...record, generation }, critical: true });
      }
    }
    const adopt: AdoptLockdownsMessage = buildAdoptLockdownsMessage();
    if (adopt.lockdowns.length > 0) {
      if (!postToNext(adopt)) {
        logger.error("Anti-Raid Worker lockdown replay was rejected.");
      }
    }
    // 黑名单处置没有状态机也没有计时器，崩溃时随 isolate 一起消失；未收到
    // 落地回执的批次必须整批重投，否则那些人就一直坐在群里（重复 ban 幂等）。
    replayPendingBlockedRemovals();
  },
  onGiveUp: (): void => {
    antiRaidBarrier.settleAll("failed");
    recoverAbandonedLockdowns();
  },
});

/** 内部 transport：尽力把一条消息投给当前代际的 Anti-Raid Worker。 */
export function postAntiRaid(message: AntiRaidWorkerMessage): boolean {
  return post(message);
}

function postAntiRaidOrThrow(message: AntiRaidWorkerMessage): void {
  if (post(message)) return;
  throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
}

/**
 * 把机器人自己的权限位镜像给 Worker：观测只发生在主线程（my_chat_member 与
 * 按需现查），而踢人/禁言/删消息都在 Worker 里执行。
 *
 * 投递失败不补偿也不记错误日志：`post` 返回 false 只发生在 Worker 已放弃或正在
 * 重建时，而 onRespawn 会整表重放（见 replayBotPermissions）。为一次必然被
 * 重放覆盖的失败刷一行 error，只会把真正的故障淹掉。
 */
registerBotPermissionObserver((chatId: number, permissions: BotChatPermissions | undefined): void => {
  post({ type: "botPermissionsChanged", chatId, ...(permissions !== undefined ? { permissions } : {}) });
});

/** 把当前整份权限镜像交给（新）Worker；任一条投递被拒即停止，由下一次重建重放。 */
function replayBotPermissions(postToNext: (message: AntiRaidWorkerMessage) => boolean): boolean {
  for (const [chatId, permissions] of botChatPermissions) {
    if (!postToNext({ type: "botPermissionsChanged", chatId, permissions })) return false;
  }
  return true;
}

registerChatTeardown("antiRaid", (chatId: number): void => {
  deactivateAntiRaidChat(chatId);
});

// Disk I/O Worker 重建时，active 与尚未确认的终结变化一起重放；否则旧日
// 文件里的 active 记录可能在下一次进程启动时复活。
onDiskIORespawn(
  "Anti-Raid verification",
  DISK_IO_RESPAWN_PRIORITIES.ANTI_RAID_VERIFICATION,
  (transport: DiskIORecoveryTransport): boolean => {
    for (const record of activeVerificationSnapshots.values()) {
      if (!transport.post({ type: "verificationUpsert", record, critical: true })) return false;
    }
    for (const deletion of pendingVerificationDeletes.values()) {
      if (!transport.post({ type: "verificationDelete", ...deletion })) return false;
    }
    return true;
  }
);

onVerificationPersisted((reply: VerificationPersistedReply): void => {
  if (!reply.deleted) {
    const current: VerificationSnapshot | undefined = activeVerificationSnapshots.get(reply.key);
    if (current?.generation !== reply.generation || current.revision !== reply.revision) return;
    persistedVerificationRevisions.set(reply.key, { generation: reply.generation, revision: reply.revision });
    // 投递失败不做补偿是有意的：Worker 不可用意味着它即将重建，onRespawn 会对
    // 终态重新投递 verificationPersisted（见上方 onRespawn）。但按
    // docs/04-invariants.md 的要求，落盘边界的 false 必须显式当作失败记录，
    // 不能静默吞掉——否则看不出这是依赖重放还是漏写。
    if (!post({
      type: "verificationPersisted",
      key: reply.key,
      generation: reply.generation,
      revision: reply.revision,
    })) {
      logger.error(
        `Anti-Raid Worker rejected the persisted verification receipt for ${reply.key}; ` +
        "relying on respawn replay to redeliver it."
      );
    }
    return;
  }
  const deletion: { chatId: number; userId: number; generation: number; revision: number; } | undefined = pendingVerificationDeletes.get(reply.key);
  if (deletion?.generation === reply.generation && deletion.revision === reply.revision) {
    pendingVerificationDeletes.delete(reply.key);
  }
});

/**
 * 启动时的私密模式接管：把 state.json 里进程上次退出时仍在生效的私密模式
 * （已随 loadState() 载入各群 ChatState.lockdown）adopt 给 Worker 重新排
 * 恢复计时。必须在 runner 开始投喂更新之前调用——FIFO 保证 adopt 先于一切
 * 新事件到达，Worker 侧「私密模式下直接踢人」的判断对随后涌入的入群立即生效。
 */
export function initAntiRaid(): void {
  if (antiRaidRuntimeState.initialized) return;
  antiRaidRuntimeState.initialized = true;
  antiRaidRuntimeState.persistenceVersion = 0;
  emergencyLockdownRecoveryRuntime.stopped = false;
  seedPersistedLockdownFingerprints();
  const generation: number = nextAntiRaidGeneration();
  try {
    initAntiRaidWorker();
    // 进程刚起来时这张表通常是空的（权限位要等 my_chat_member 或首次按需现查），
    // 重放仍然照做：它让「Worker 每次(重)启动后都持有当前镜像」这条不变量无条件
    // 成立，不必依赖调用顺序去论证某一次为空。
    replayBotPermissions(post);
    postAntiRaidOrThrow(buildAdoptVerificationsMessage(generation, true));
    // 启动恢复的 outbox 已在 hydrateBlocklist 中按当前黑名单与管理状态过滤。
    // 后台重放不阻塞 runner 启动；任务本身已经 durable，完整进程退出后仍可恢复。
    replayPendingBlockedRemovals(false);
    const adopt: AdoptLockdownsMessage = buildAdoptLockdownsMessage();
    if (adopt.lockdowns.length === 0) return;

    postAntiRaidOrThrow(adopt);
    logger.log(`Adopted lockdowns still active from previous process exit: ${adopt.lockdowns.map((l: AdoptableLockdown): number => l.chatId).join(", ")}`);
  } catch (error: unknown) {
    antiRaidRuntimeState.initialized = false;
    stopEmergencyLockdownRecoveries();
    throw error;
  }
}

/** 统一群 teardown 入口：Worker 内取消验证并对 lockdown 发起可恢复解锁。 */
export function deactivateAntiRaidChat(chatId: number): void {
  postAntiRaidOrThrow({ type: "deactivateChat", chatId });
}

/**
 * `/ad_detect disable` 的运行态收尾：丢掉这个群还排在 Worker 里的待检消息串。
 * 主线程那道门禁只拦得住之后的消息，已经排进队列的那些若继续判定，关掉开关
 * 之后还会有人被拉黑。
 *
 * **投递失败必须由调用方兜住，不能让它逃出 update handler**（见
 * commands/adDetect.ts，同 commands/aiChat.ts 的 invalidateAiChat）。`post()` 只在
 * 两种状态下返回 false——Worker 用尽重启预算被放弃，或正在重生——而这两种状态下
 * 那个待检队列本来就跟着旧 isolate 一起没了，没有任何东西需要清。反过来放它抛
 * 出去的代价是实打实的：开关已经落盘，这条 update 却被判失败，最终 offset 扣住
 * 不确认、进程非零退出，重启后 Telegram 重投同一条 `/ad_detect disable`——而
 * Worker 仍然不可用，重投同样失败，恰好把重启循环焊死。
 */
export function clearAdDetection(chatId: number): void {
  postAntiRaidOrThrow({ type: "clearAdDetect", chatId });
}

/** 停机时终止 Worker；验证/lockdown 的 write-ahead 镜像已在主线程持有。 */
export async function terminateAntiRaid(): Promise<void> {
  antiRaidBarrier.settleAll("failed");
  antiRaidRuntimeState.initialized = false;
  stopEmergencyLockdownRecoveries();
  await terminateAntiRaidWorker();
}

/** Disk I/O 启动恢复完成后、Anti-Raid Worker 初始化前灌入主线程镜像。 */
export function hydratePendingVerifications(records: Map<string, VerificationSnapshot>): void {
  if (antiRaidRuntimeState.initialized) {
    throw new Error("Pending verifications must be hydrated before Anti-Raid initialization.");
  }
  activeVerificationSnapshots.clear();
  pendingVerificationDeletes.clear();
  persistedVerificationRevisions.clear();
  for (const [key, record] of records) {
    activeVerificationSnapshots.set(key, {
      ...record,
      trackedMessageTimes: [...record.trackedMessageTimes],
    });
    persistedVerificationRevisions.set(key, { generation: record.generation, revision: record.revision });
  }
}
