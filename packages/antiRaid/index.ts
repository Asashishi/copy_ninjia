import { logger } from "../infra/logger";
import type { Context } from "grammy";
import type { Message, ChatMemberUpdated, User, CallbackQuery } from "@grammyjs/types";
import { clearChatStateField, flushStateToDisk, getAllChatStates, getOrCreateChatState, saveState, saveStateInBackground } from "../infra/storage/stateStore";
import { answerCallbackQuery } from "../infra/telegram/actions";
import { isBotAdminIn, markBotAdminObserved } from "../infra/botAdmin";
import { registerChatTeardown } from "../infra/chatTeardown";
import { VERIFY_CALLBACK_PREFIX } from "../consts/antiRaid/verification";
import {
  ANTI_RAID_BARRIER_TIMEOUT_MS,
  ANTI_RAID_DRAIN_MAX_ROUNDS,
  LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS,
} from "../consts/antiRaid/protocol";
import type { FlushResult } from "../types/lifecycle";
import { isAdminStatus } from "../libs/chatMember";
import { superviseWorker } from "../libs/supervisedWorker";
import { verificationKey } from "../libs/verificationKey";
import { WorkerUndeliveredError } from "../libs/workerDelivery";
import { flushDiskIO, onDiskIORespawn, onVerificationPersisted, postDiskIO } from "../workers/antiRaid/persistence";
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
import { claimBlockedJoiner, registerBlocklistRemoval } from "./blocklistGuard";
import { buildAdCandidate, drainAdDisposals, handleAdDetected } from "./adDetect";
import {
  replayPendingBlockedRemovals,
  settleBlockedRemoval,
} from "../infra/blocklist";
import { isActiveChatMember, isInviterExemptAdmin, pickMember } from "./memberFacts";
import { prepareDurableAntiRaidMessages } from "./blocklistDelivery";
import { antiRaidBarrier, antiRaidRuntimeState } from "../cache/antiRaid/proxy";
import {
  emergencyLockdownRecoveryRuntime,
  pendingLockdownPersistence,
  persistedLockdownFingerprints,
  type PersistedLockdownFingerprint,
} from "../cache/antiRaid/lockdownMirror";
import {
  activeVerificationSnapshots,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
} from "../cache/antiRaid/verificationMirror";
import type { AdCandidateMessage, AdoptLockdownsMessage, AdoptVerificationsMessage, AntiRaidWorkerEvent, AntiRaidWorkerMessage, VerificationSnapshot, AdoptableLockdown } from "../types/antiRaid";
import type { LockdownRecord } from "../types/chatState";
import type { SupervisedWorkerHandle } from "../libs/supervisedWorker";
import type { VerificationPersistedReply } from "../types/diskIO";

/**
 * 入群守卫入口（主线程侧代理）：入群验证 + 反刷群私密模式。真正的逻辑
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
 * 一次。指纹只含 phase + intentId（见 cache/antiRaid.ts），因此重来一轮意味着
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

function postAntiRaidOrThrow(message: AntiRaidWorkerMessage): void {
  if (post(message)) return;
  throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
}

// 黑名单清扫的执行 owner（判定在 infra/blocklist.ts，执行在 Worker）。
registerBlocklistRemoval(postAntiRaidDurably);

registerChatTeardown("antiRaid", (chatId: number): void => {
  deactivateAntiRaidChat(chatId);
});

/** FIFO mailbox barrier：只证明此前消息已同步路由，不等待后台网络副作用。 */
function barrierAntiRaidMailbox(timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return Promise.resolve("flushed");
  return antiRaidBarrier.begin(
    (barrierId: number): boolean => post({ type: "barrier", barrierId }),
    timeoutMs
  );
}

/** 等待 Worker 此前启动的异步副作用全部结算，不处理跨线程持久化握手。 */
function drainAntiRaidWorkerTasks(timeoutMs: number): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return Promise.resolve("flushed");
  return antiRaidBarrier.begin(
    (drainId: number): boolean => post({ type: "drain", drainId }),
    timeoutMs
  );
}

function remainingDrainTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * 停机排空：先 quiesce Worker 广告判定并取得 FIFO drain 回执，再等待主线程
 * 广告处置；随后让已有镜像落盘并把持久化回执交回 Worker，等待由回执放行的
 * 网络副作用。若副作用又发布了新镜像则重复，直到固定点或达到轮数上限。
 */
export async function drainAntiRaid(timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return "flushed";
  const deadline: number = Date.now() + timeoutMs;
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
    const disposalResult: FlushResult = await drainAdDisposals(remainingDrainTime(deadline));
    if (disposalResult !== "flushed") return disposalResult;
    const initialBarrier: FlushResult = await barrierAntiRaidMailbox(remainingDrainTime(deadline));
    if (initialBarrier !== "flushed") return initialBarrier;

    const persistenceResults: [PromiseSettledResult<FlushResult>, PromiseSettledResult<FlushResult>] =
      await Promise.allSettled([
        flushDiskIO(remainingDrainTime(deadline)),
        flushStateToDisk(remainingDrainTime(deadline)),
      ]);
    if (persistenceResults.some((result: PromiseSettledResult<FlushResult>): boolean =>
      result.status === "rejected")) {
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
    const receiptBarrier: FlushResult = await barrierAntiRaidMailbox(remainingDrainTime(deadline));
    if (receiptBarrier !== "flushed") return receiptBarrier;
    const persistenceVersionBeforeTasks: number = antiRaidRuntimeState.persistenceVersion;
    const taskResult: FlushResult =
      await drainAntiRaidWorkerTasks(remainingDrainTime(deadline));
    if (taskResult !== "flushed") return taskResult;
    if (antiRaidRuntimeState.persistenceVersion === persistenceVersionBeforeTasks) {
      return "flushed";
    }
  }
  logger.error(
    `Anti-Raid drain did not converge after ${ANTI_RAID_DRAIN_MAX_ROUNDS} persistence rounds.`
  );
  return "failed";
}

/** update 安全交接：处理 mailbox 后，仅在镜像变化时同步两类持久化 owner。 */
async function postAntiRaidDurably(
  messages: readonly AntiRaidWorkerMessage[],
  timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS
): Promise<void> {
  let messagesToPost: readonly AntiRaidWorkerMessage[] = messages;
  if (messages.some((message: AntiRaidWorkerMessage): boolean => message.type === "removeBlockedMembers")) {
    // 黑名单处置是安全副作用：update 被确认前先把主线程镜像写入持久化 outbox。
    // mailbox barrier 只证明 Worker 收到消息，不能替代跨进程恢复能力。
    messagesToPost = await prepareDurableAntiRaidMessages(messages);
  }
  if (messagesToPost.length === 0) return;
  const persistenceVersionBefore: number = antiRaidRuntimeState.persistenceVersion;
  for (const message of messagesToPost) {
    // 只有这一条路径代表「Worker 压根没收到」。下面的屏障失败与落盘失败都
    // 意味着它已经收下并在后台执行；两者仍要保留 durable 镜像，但错误类型
    // 必须可区分，供调用方判断本次是否可能已启动副作用（见 workerDelivery.ts）。
    if (!post(message)) throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
  }
  const barrierResult: FlushResult = await barrierAntiRaidMailbox(timeoutMs);
  if (barrierResult !== "flushed") {
    throw new Error(`Anti-Raid Worker barrier ${barrierResult}.`);
  }
  if (antiRaidRuntimeState.persistenceVersion === persistenceVersionBefore) return;
  const persistenceResults: [PromiseSettledResult<FlushResult>, PromiseSettledResult<FlushResult>] = await Promise.allSettled([
    flushDiskIO(timeoutMs),
    flushStateToDisk(timeoutMs),
  ]);
  const failures: unknown[] = persistenceResults
    .filter((result: PromiseSettledResult<FlushResult>): result is PromiseRejectedResult => result.status === "rejected")
    .map((result: PromiseRejectedResult): unknown => result.reason as unknown);
  if (failures.length > 0) throw new AggregateError(failures, "Anti-Raid persistence boundary rejected.");
  const diskResult: FlushResult = (persistenceResults[0] as PromiseFulfilledResult<FlushResult>).value;
  const stateResult: FlushResult = (persistenceResults[1] as PromiseFulfilledResult<FlushResult>).value;
  if (diskResult !== "flushed" || stateResult !== "flushed") {
    throw new Error(`Anti-Raid persistence failed: disk=${diskResult}, state=${stateResult}.`);
  }
}

// Disk I/O Worker 重建时，active 与尚未确认的终结变化一起重放；否则旧日
// 文件里的 active 记录可能在下一次进程启动时复活。
onDiskIORespawn((): void => {
  for (const record of activeVerificationSnapshots.values()) {
    postDiskIO({ type: "verificationUpsert", record, critical: true });
  }
  for (const deletion of pendingVerificationDeletes.values()) {
    postDiskIO({ type: "verificationDelete", ...deletion });
  }
});

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
 * 投递失败必须上抛——主线程这道门禁只拦得住之后的消息，已经排进队列的那些
 * 若继续判定，关掉开关之后还会有人被拉黑。
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
      messageIds: [...record.messageIds],
      trackedMessageTimes: [...record.trackedMessageTimes],
    });
    persistedVerificationRevisions.set(key, { generation: record.generation, revision: record.revision });
  }
}

/**
 * 处理 `chat_member` 更新：这是权威且始终会送达的入群/离群信号（不同于
 * `new_chat_members`/`left_chat_member` 服务消息——一旦群组开启了"隐藏入群/
 * 离群消息"，这些服务消息就完全不会再发送）。要接收非机器人自身成员的这类
 * 更新，需要机器人是群管理员——而封禁/删除消息本来也需要这个权限。
 */
export async function handleChatMemberUpdate(ctx: Context): Promise<void> {
  const update: ChatMemberUpdated | undefined = ctx.chatMember;
  if (!update) return;

  const chatId: number = update.chat.id;
  const user: User = update.new_chat_member.user;
  // 自身的成员变动本来走 my_chat_member；这条排除必须放在最前面——万一
  // Telegram 真的也为机器人自己送来一条 chat_member（比如这次恰好就是自己
  // 被撤管理员），排在下面 markBotAdminObserved 之后会被误判：那条推理
  // （"收到别人的 chat_member 就证明自己此刻是管理员"）建立在"这是关于
  // 别人的更新"之上，套在这条报告自己被撤权的更新上会得出恰好相反的结论。
  if (user.id === ctx.me.id) return;

  // 能收到别人的 chat_member 更新，本身就证明机器人此刻是本群管理员——
  // 顺手记录（见 botAdmin.ts），这条路径无需（也不能）做非管理员门控：
  // 不是管理员时这类更新根本不会送达。
  await markBotAdminObserved(chatId);

  // 机器人不再豁免——僵尸 bot 也会被批量拉进群刷屏，照常走验证（由白名单
  // 用户代点按钮作保）。
  const wasActive: boolean = isActiveChatMember(update.old_chat_member);
  const isActive: boolean = isActiveChatMember(update.new_chat_member);

  // 管理员任免、入离群及匿名模式切换同样以 chat_member 更新送达：同步给
  // Worker 侧的邀请者豁免缓存，让「非匿名管理员拉人免验证」的同步判定
  // 近乎实时，缓存 TTL 只是兜底。FIFO 保证它先于随后的 join/left 投递生效。
  const isAdmin: boolean = isAdminStatus(update.new_chat_member.status);
  const wasInviterExempt: boolean = isInviterExemptAdmin(update.old_chat_member);
  const isInviterExempt: boolean = isInviterExemptAdmin(update.new_chat_member);
  const messages: AntiRaidWorkerMessage[] = [];
  if (wasInviterExempt !== isInviterExempt) {
    messages.push({ type: "adminsChanged", chatId, userId: user.id, isInviterExempt });
  }

  if (!wasActive && isActive) {
    // 黑名单优先于一切豁免，且取代 join 投递：Worker 不会为一个马上要被踢掉的人开窗口。
    // 这一路没有入群公告（chat_member 更新不带服务消息），刷群计数由处置消息补记。
    if (!claimBlockedJoiner({ chatId, userId: user.id, messages })) {
      // 以管理员/群主身份入群的（典型如群主退群重进）免验证。身份只有本路径
      // 可见，new_chat_members 服务消息里没有——所以不能简单跳过不投递，而要
      // 带 exempt 标记投给 Worker：若服务消息那一路已抢先开了验证窗口，Worker
      // 收到豁免后会将其撤销。
      messages.push({ type: "join", chatId, member: pickMember(user), exempt: isAdmin, actorId: update.from.id });
    }
  } else if (wasActive && !isActive) {
    messages.push({ type: "left", chatId, userId: user.id });
  }
  if (messages.length > 0) await postAntiRaidDurably(messages);
}

/**
 * 消息事件的投递入口，在 app/registerHandlers.ts 里以中间件形式挂在所有
 * 命令处理器之前
 * ——这样待验证用户发的命令消息（/copy 之类）也会被追踪，超时踢人时
 * 一并清理，不给刷群脚本留「刷命令就删不掉」的空子。职责：在群组未隐藏
 * `new_chat_members`/`left_chat_member` 服务消息时顺带捕获它们（以便这些
 * 消息的 ID 也能被 Worker 追踪/清理），同时把每条消息的（chatId, userId,
 * messageId）投递给 Worker，用于追踪待验证用户在等待期间发送的消息。
 * 入群/离群本身的检测由 handleChatMemberUpdate 驱动——与这些服务消息
 * 不同，它总是会触发。
 * @returns 若消息在此已被完全处理、调用方应跳过后续处理逻辑（入群公告），
 * 返回 true；否则返回 false，让消息正常继续流转。
 */
export async function handleGroupJoinVerification(message: Message, botId: number): Promise<boolean> {
  // 验证只发生在群聊里，私聊消息不必跨线程投递去查一次注定落空的 Map。
  if (message.chat?.type === "private") return false;

  // 机器人不是本群管理员时整个入群守卫不启动：踢人/删消息都做不了，投递
  // 过去只会让 Worker 开一堆注定失败的验证窗口、刷一堆权限报错。已有身份
  // 记录时这个判定是同步的（不打 API），只有从未记录过的群会现查一次。
  // 入群公告照样吞掉（服务消息本来就不该流进复读/AI 流水线），只是不投递。
  if (!(await isBotAdminIn(message.chat.id))) {
    return !!(message.new_chat_members && message.new_chat_members.length > 0);
  }

  // 广告检测与入群守卫共用上面那道管理员判定：不是管理员就删不掉广告也封不了
  // 人，判一次纯属白烧额度。投递是尽力而为的——Worker 不可用只意味着它正在
  // 重建，而待检队列本来就随 isolate 一起清空，不值得为它拒收这条 update。
  const adCandidate: AdCandidateMessage | undefined = buildAdCandidate(message, botId);
  if (adCandidate !== undefined && !post(adCandidate)) {
    logger.error(`Anti-Raid Worker rejected an ad detection candidate from chat ${message.chat.id}.`);
  }

  if (message.new_chat_members && message.new_chat_members.length > 0) {
    const messages: AntiRaidWorkerMessage[] = [];
    for (const member of message.new_chat_members) {
      // 机器人不再豁免（走白名单用户代点验证的流程），只跳过本天才自己
      // ——自己既不能验证自己，也不该被自己踢出去。
      if (member.id === botId) continue;
      // 与 chat_member 那一路会为同一次入群各投一次处置；重复 ban 幂等，但两条都要拦
      // ——隐藏入群消息的群只有 chat_member 会到，而 chat_member 又要管理员权限才送达。
      if (claimBlockedJoiner({
        chatId: message.chat.id,
        userId: member.id,
        messages,
        // 服务消息这一路带得到入群公告；不投 join 就没人再管它，交给处置一并删。
        announcementMessageId: message.message_id,
      })) continue;
      messages.push({ type: "join", chatId: message.chat.id, member: pickMember(member), announcementMessageId: message.message_id, actorId: message.from?.id });
    }
    if (messages.length > 0) await postAntiRaidDurably(messages);
    return true;
  }

  if (message.left_chat_member) {
    await postAntiRaidDurably([{ type: "left", chatId: message.chat.id, userId: message.left_chat_member.id }]);
    return false;
  }

  const userId: number | undefined = message.from?.id;
  // message_thread_id 有两个来源：关联频道讨论组的评论线程，和论坛（topics）
  // 群里的话题。只有前者可能是「评论早于 join 更新到达」的候选；论坛话题回复
  // 永远不可能是频道评论，把它排除掉，否则开了 topics 的群里每条普通消息都要
  // 白走一次 Worker barrier 与关联频道探测。
  const isCommentThreadReply: boolean =
    message.message_thread_id !== undefined && message.is_topic_message !== true;
  const mayPrecedeJoinInCommentThread: boolean =
    message.reply_to_message?.is_automatic_forward === true || isCommentThreadReply;
  if (
    userId !== undefined &&
    (activeVerificationSnapshots.has(verificationKey(message.chat.id, userId)) || mayPrecedeJoinInCommentThread)
  ) {
    // 附带频道评论区的识别线索：评论与楼中楼回复都代表 TA 已实际参与讨论，
    // Worker 据此免除验证且不计入刷群窗口。没有任何评论区消息的普通入群
    // 照常验证，超时仍会被踢出。
    await postAntiRaidDurably([{
      type: "message",
      chatId: message.chat.id,
      userId,
      messageId: message.message_id,
      repliesToChannelPost: message.reply_to_message?.is_automatic_forward === true,
      isThreadReply: isCommentThreadReply,
    }]);
  }
  return false;
}

/**
 * 处理入群验证按钮的点击（callback_query）：解析出目标成员后整体投递给
 * Worker 应答与处理。前缀不匹配的 callback_query 与本模块无关，直接放过。
 */
export async function handleVerificationCallback(ctx: Context): Promise<void> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  const data: string | undefined = query?.data;
  if (!query || !data?.startsWith(VERIFY_CALLBACK_PREFIX)) return;

  const targetUserId: number = Number(data.slice(VERIFY_CALLBACK_PREFIX.length));
  // callback_data 属于外部输入：前缀匹配不代表后半段一定是合法整数。NaN 若
  // 进入 Worker 会生成 "chatId:NaN" 状态键，按钮只会永远转圈且留下脏状态。
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    await answerCallbackQuery({ callbackQueryId: query.id, text: "验证请求无效", showAlert: true });
    return;
  }

  await postAntiRaidDurably([{
    type: "callback",
    callbackQueryId: query.id,
    chatId: query.message?.chat.id,
    targetUserId,
    from: pickMember(query.from),
  }]);
}
