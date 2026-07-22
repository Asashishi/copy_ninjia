import { logger } from "./infra/logger";
import type { Context } from "grammy";
import type { ChatMember, Message } from "@grammyjs/types";
import { clearChatStateField, flushStateToDisk, getAllChatStates, getOrCreateChatState, saveState, saveStateInBackground } from "./infra/storage/stateStore";
import { answerCallbackQuery } from "./infra/telegram/actions";
import { joinVerificationApi } from "./infra/telegram/client";
import { restoreLockdownInvitePermission } from "./infra/telegram/lockdownPermissions";
import { isBotAdminIn, markBotAdminObserved } from "./infra/botAdmin";
import { registerChatTeardown } from "./infra/chatTeardown";
import { RESTORE_RETRY_MS } from "./consts/antiRaid/lockdown";
import { VERIFY_CALLBACK_PREFIX } from "./consts/antiRaid/verification";
import { ANTI_RAID_BARRIER_TIMEOUT_MS } from "./consts/antiRaid/protocol";
import type { FlushResult } from "./consts/lifecycle";
import { createFlushBarrier } from "./libs/flushBarrier";
import { isAdminStatus } from "./libs/chatMember";
import { superviseWorker } from "./libs/supervisedWorker";
import { verificationKey } from "./libs/verificationKey";
import { flushDiskIO, onDiskIORespawn, onVerificationPersisted, postDiskIO } from "./workers/antiRaid/persistence";
import {
  activeVerificationSnapshots,
  antiRaidRuntimeState,
  emergencyLockdownRecoveries,
  emergencyLockdownRecoveryRuntime,
  pendingLockdownPersistence,
  pendingVerificationDeletes,
  persistedLockdownFingerprints,
  persistedVerificationRevisions,
  type EmergencyLockdownRecovery,
  type PersistedLockdownFingerprint,
} from "./cache/antiRaid";
import type { AdoptableLockdown, AdoptLockdownsMessage, AdoptVerificationsMessage, AntiRaidMember, AntiRaidWorkerEvent, AntiRaidWorkerMessage, VerificationDeleteEvent, VerificationSnapshot, VerificationUpsertEvent } from "./types/antiRaid";
import type { LockdownRecord } from "./types/chatState";

const antiRaidBarrier = createFlushBarrier({ timeoutMs: ANTI_RAID_BARRIER_TIMEOUT_MS });

/**
 * 入群守卫入口（主线程侧代理）：入群验证 + 反刷群私密模式。真正的逻辑
 * ——验证窗口、超时踢人、按钮应答、入群计数、私密模式的触发/恢复、
 * 私密模式期间的删公告 + 踢人——全部在独立的 Bun Worker
 * （src/workers/antiRaidWorker.ts）里执行；正常路径下主线程只从 grammY
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

function lockdownFingerprint(record: LockdownRecord): PersistedLockdownFingerprint {
  return {
    phase: record.phase ?? "active",
    intentId: record.intentId ?? 0,
    expiresAt: record.expiresAt,
  };
}

function fingerprintMatches(record: LockdownRecord, fingerprint: PersistedLockdownFingerprint | undefined): boolean {
  const current: PersistedLockdownFingerprint = lockdownFingerprint(record);
  return fingerprint?.phase === current.phase &&
    fingerprint.intentId === current.intentId &&
    fingerprint.expiresAt === current.expiresAt;
}

function toAdoptableLockdown(chatId: number, record: LockdownRecord, now: number): AdoptableLockdown {
  return {
    chatId,
    phase: record.phase ?? "active",
    intentId: record.intentId ?? 0,
    originalPermissions: record.originalPermissions,
    remainingMs: Math.max(0, record.expiresAt - now),
    persisted: fingerprintMatches(record, persistedLockdownFingerprints.get(chatId)),
  };
}

/** 收集当前仍在生效的私密模式，换算出各自的真实剩余时长。 */
function collectActiveLockdowns(): AdoptableLockdown[] {
  const lockdowns: AdoptableLockdown[] = [];
  const now: number = Date.now();
  for (const [chatId, chatState] of getAllChatStates()) {
    if (chatState.lockdown) {
      lockdowns.push(toAdoptableLockdown(chatId, chatState.lockdown, now));
    }
  }
  return lockdowns;
}

/** 把仍在生效的私密模式打包成 adopt 消息（两条恢复路径共用）。 */
function buildAdoptMessage(): AdoptLockdownsMessage {
  return { type: "adopt", lockdowns: collectActiveLockdowns() };
}

function persistCurrentLockdown(chatId: number): void {
  if (pendingLockdownPersistence.has(chatId)) return;
  pendingLockdownPersistence.add(chatId);
  void (async (): Promise<void> => {
    while (true) {
      const expected: LockdownRecord | undefined = getAllChatStates().get(chatId)?.lockdown;
      if (expected === undefined) return;
      const expectedFingerprint: PersistedLockdownFingerprint = lockdownFingerprint(expected);
      await saveState();
      const current: LockdownRecord | undefined = getAllChatStates().get(chatId)?.lockdown;
      if (current === undefined) return;
      if (!fingerprintMatches(current, expectedFingerprint)) continue;
      persistedLockdownFingerprints.set(chatId, expectedFingerprint);
      post({
        type: "lockdownPersisted",
        chatId,
        phase: expectedFingerprint.phase,
        intentId: expectedFingerprint.intentId,
      });
      return;
    }
  })()
    .catch((error: unknown) => {
      logger.error(`Failed to persist anti-raid lockdown intent for chat ${chatId}:`, error);
    })
    .finally(() => {
      pendingLockdownPersistence.delete(chatId);
    });
}

function finishEmergencyLockdownRecovery(chatId: number, recovery: EmergencyLockdownRecovery): void {
  if (recovery.retryTimer !== null) {
    clearTimeout(recovery.retryTimer);
    recovery.retryTimer = null;
  }
  if (emergencyLockdownRecoveries.get(chatId) === recovery) {
    emergencyLockdownRecoveries.delete(chatId);
  }
}

function runEmergencyLockdownRecovery(chatId: number, recovery: EmergencyLockdownRecovery): void {
  if (
    emergencyLockdownRecoveryRuntime.stopped ||
    emergencyLockdownRecoveries.get(chatId) !== recovery ||
    recovery.inFlight !== null
  ) return;

  const task: Promise<void> = (async (): Promise<void> => {
    const before: LockdownRecord | undefined = getAllChatStates().get(chatId)?.lockdown;
    if (before === undefined || !fingerprintMatches(before, recovery.fingerprint)) {
      finishEmergencyLockdownRecovery(chatId, recovery);
      return;
    }
    try {
      await restoreLockdownInvitePermission({
        chatId,
        originalPermissions: recovery.originalPermissions,
        api: joinVerificationApi,
      });
      if (
        emergencyLockdownRecoveryRuntime.stopped ||
        emergencyLockdownRecoveries.get(chatId) !== recovery
      ) {
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      const current: LockdownRecord | undefined = getAllChatStates().get(chatId)?.lockdown;
      if (current === undefined || !fingerprintMatches(current, recovery.fingerprint)) {
        logger.warn(
          `Emergency anti-raid restore for chat ${chatId} completed after its lockdown intent changed; ` +
          "leaving the newer state untouched."
        );
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      persistedLockdownFingerprints.delete(chatId);
      if (clearChatStateField(chatId, "lockdown")) {
        saveStateInBackground("emergency anti-raid unlock");
        antiRaidRuntimeState.persistenceVersion++;
      }
      logger.log(`Emergency anti-raid permission restore completed for chat ${chatId}.`);
      finishEmergencyLockdownRecovery(chatId, recovery);
    } catch (error: unknown) {
      const current: LockdownRecord | undefined = getAllChatStates().get(chatId)?.lockdown;
      if (
        emergencyLockdownRecoveryRuntime.stopped ||
        current === undefined ||
        !fingerprintMatches(current, recovery.fingerprint) ||
        emergencyLockdownRecoveries.get(chatId) !== recovery
      ) {
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      logger.error(
        `Emergency anti-raid permission restore failed for chat ${chatId}; ` +
        `retrying in ${RESTORE_RETRY_MS / 1000}s:`,
        error
      );
      recovery.retryTimer = setTimeout(() => {
        recovery.retryTimer = null;
        runEmergencyLockdownRecovery(chatId, recovery);
      }, RESTORE_RETRY_MS);
      recovery.retryTimer.unref();
    }
  })();
  recovery.inFlight = task;
  void task.finally(() => {
    if (recovery.inFlight === task) recovery.inFlight = null;
  });
}

function startEmergencyLockdownRecovery(chatId: number, record: LockdownRecord): void {
  const fingerprint: PersistedLockdownFingerprint = lockdownFingerprint(record);
  const existing: EmergencyLockdownRecovery | undefined = emergencyLockdownRecoveries.get(chatId);
  if (existing !== undefined) {
    if (
      existing.fingerprint.phase === fingerprint.phase &&
      existing.fingerprint.intentId === fingerprint.intentId &&
      existing.fingerprint.expiresAt === fingerprint.expiresAt
    ) return;
    finishEmergencyLockdownRecovery(chatId, existing);
  }
  const recovery: EmergencyLockdownRecovery = {
    fingerprint,
    originalPermissions: { ...record.originalPermissions },
    retryTimer: null,
    inFlight: null,
  };
  emergencyLockdownRecoveries.set(chatId, recovery);
  runEmergencyLockdownRecovery(chatId, recovery);
}

function stopEmergencyLockdownRecoveries(): void {
  emergencyLockdownRecoveryRuntime.stopped = true;
  for (const recovery of emergencyLockdownRecoveries.values()) {
    if (recovery.retryTimer !== null) {
      clearTimeout(recovery.retryTimer);
      recovery.retryTimer = null;
    }
  }
  // Telegram 请求本身可能永久悬挂，停机不能越过生命周期预算无限等待。
  // 已关闸且清空 owner；迟到的成功/失败都会在 run 中停止，不再修改 state
  // 或重新安排 timer。state 保留 lockdown，下一进程可幂等恢复权限。
  emergencyLockdownRecoveries.clear();
}

const { init: initAntiRaidWorker, post, terminate: terminateAntiRaidWorker } = superviseWorker<AntiRaidWorkerMessage, AntiRaidWorkerEvent>({
  url: new URL("./workers/antiRaidWorker.ts", import.meta.url).href,
  label: "Anti-raid guard Worker",
  giveUpConsequence: "join verification and anti-raid features will silently stay disabled until the process restarts.",
  onEvent: (event) => {
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
      case "barrierComplete": {
        antiRaidBarrier.settle(event.barrierId, "flushed");
        break;
      }
    }
  },
  // 崩溃的 Worker 带走了所有计时器；先用主线程待验证镜像重建验证，再把
  // 仍在生效的私密模式交给新 Worker。FIFO 保证两类 adopt 都先于新投递。
  onRespawn: (postToNext) => {
    antiRaidBarrier.settleAll("failed");
    const generation: number = nextAntiRaidGeneration();
    for (const [key, record] of activeVerificationSnapshots) {
      const persisted = persistedVerificationRevisions.get(key);
      activeVerificationSnapshots.set(key, { ...record, generation });
      if (persisted?.generation === record.generation && persisted.revision === record.revision) {
        persistedVerificationRevisions.set(key, { generation, revision: record.revision });
      }
    }
    postToNext(buildAdoptVerificationsMessage(generation));
    for (const [key, record] of activeVerificationSnapshots) {
      if (record.phase !== "checkingInviter" && record.phase !== "expelling") continue;
      const persisted = persistedVerificationRevisions.get(key);
      if (persisted?.generation === record.generation && persisted.revision === record.revision) {
        postToNext({ type: "verificationPersisted", key, generation, revision: record.revision });
      } else {
        // 旧 Worker 可能在终态 upsert 发出后、落盘回执前崩溃；重新提交并等待
        // Disk I/O 的精确 revision 回执，绝不凭主线程镜像直接执行踢人。
        postDiskIO({ type: "verificationUpsert", record: { ...record, generation }, critical: true });
      }
    }
    const adopt: AdoptLockdownsMessage = buildAdoptMessage();
    if (adopt.lockdowns.length > 0) {
      postToNext(adopt);
    }
  },
  onGiveUp: () => {
    antiRaidBarrier.settleAll("failed");
    recoverAbandonedLockdowns();
  },
});

registerChatTeardown("antiRaid", (chatId: number): void => {
  post({ type: "deactivateChat", chatId });
});

function acceptVerificationUpsert(event: VerificationUpsertEvent): boolean {
  const snapshot: VerificationSnapshot = event.record;
  if (snapshot.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(snapshot.chatId, snapshot.userId);
  const latestRevision: number = Math.max(
    activeVerificationSnapshots.get(key)?.revision ?? 0,
    pendingVerificationDeletes.get(key)?.revision ?? 0
  );
  if (snapshot.revision <= latestRevision) return false;
  const critical: boolean = !activeVerificationSnapshots.has(key) ||
    snapshot.phase === "checkingInviter" || snapshot.phase === "expelling";
  activeVerificationSnapshots.set(key, {
    ...snapshot,
    messageIds: [...snapshot.messageIds],
    trackedMessageTimes: snapshot.trackedMessageTimes === undefined ? undefined : [...snapshot.trackedMessageTimes],
  });
  pendingVerificationDeletes.delete(key);
  postDiskIO({ type: "verificationUpsert", record: snapshot, critical });
  return true;
}

function acceptVerificationDelete(event: VerificationDeleteEvent): boolean {
  if (event.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(event.chatId, event.userId);
  const current: VerificationSnapshot | undefined = activeVerificationSnapshots.get(key);
  const pendingRevision: number = pendingVerificationDeletes.get(key)?.revision ?? 0;
  if ((!current && pendingRevision === 0) || event.revision <= Math.max(current?.revision ?? 0, pendingRevision)) return false;
  activeVerificationSnapshots.delete(key);
  persistedVerificationRevisions.delete(key);
  const deletion = {
    chatId: event.chatId,
    userId: event.userId,
    generation: event.generation,
    revision: event.revision,
  };
  pendingVerificationDeletes.set(key, deletion);
  postDiskIO({ type: "verificationDelete", ...deletion });
  return true;
}

/** FIFO barrier：回执前 Worker 已同步处理完此前消息，镜像事件也已先到主线程。 */
export function drainAntiRaid(timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS): Promise<FlushResult> {
  if (!antiRaidRuntimeState.initialized) return Promise.resolve("flushed");
  return antiRaidBarrier.begin(
    (barrierId) => post({ type: "barrier", barrierId }),
    timeoutMs
  );
}

/** update 安全交接：处理 mailbox 后，仅在镜像变化时同步两类持久化 owner。 */
async function postAntiRaidDurably(
  messages: readonly AntiRaidWorkerMessage[],
  timeoutMs: number = ANTI_RAID_BARRIER_TIMEOUT_MS
): Promise<void> {
  const persistenceVersionBefore: number = antiRaidRuntimeState.persistenceVersion;
  for (const message of messages) {
    if (!post(message)) throw new Error("Anti-Raid Worker is unavailable.");
  }
  const barrierResult: FlushResult = await drainAntiRaid(timeoutMs);
  if (barrierResult !== "flushed") {
    throw new Error(`Anti-Raid Worker barrier ${barrierResult}.`);
  }
  if (antiRaidRuntimeState.persistenceVersion === persistenceVersionBefore) return;
  const persistenceResults = await Promise.allSettled([
    flushDiskIO(timeoutMs),
    flushStateToDisk(timeoutMs),
  ]);
  const failures: unknown[] = persistenceResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (failures.length > 0) throw new AggregateError(failures, "Anti-Raid persistence boundary rejected.");
  const diskResult: FlushResult = (persistenceResults[0] as PromiseFulfilledResult<FlushResult>).value;
  const stateResult: FlushResult = (persistenceResults[1] as PromiseFulfilledResult<FlushResult>).value;
  if (diskResult !== "flushed" || stateResult !== "flushed") {
    throw new Error(`Anti-Raid persistence failed: disk=${diskResult}, state=${stateResult}.`);
  }
}

// Disk I/O Worker 重建时，active 与尚未确认的终结变化一起重放；否则旧日
// 文件里的 active 记录可能在下一次进程启动时复活。
onDiskIORespawn(() => {
  for (const record of activeVerificationSnapshots.values()) {
    postDiskIO({ type: "verificationUpsert", record, critical: true });
  }
  for (const deletion of pendingVerificationDeletes.values()) {
    postDiskIO({ type: "verificationDelete", ...deletion });
  }
});

onVerificationPersisted((reply) => {
  if (!reply.deleted) {
    const current = activeVerificationSnapshots.get(reply.key);
    if (current?.generation !== reply.generation || current.revision !== reply.revision) return;
    persistedVerificationRevisions.set(reply.key, { generation: reply.generation, revision: reply.revision });
    post({
      type: "verificationPersisted",
      key: reply.key,
      generation: reply.generation,
      revision: reply.revision,
    });
    return;
  }
  const deletion = pendingVerificationDeletes.get(reply.key);
  if (deletion?.generation === reply.generation && deletion.revision === reply.revision) {
    pendingVerificationDeletes.delete(reply.key);
  }
});

/** Worker 自愈放弃后，由主线程独立接管仍挂着的邀请权限恢复。 */
function recoverAbandonedLockdowns(): void {
  const abandoned: number[] = [];
  for (const [chatId, chatState] of getAllChatStates()) {
    if (chatState.lockdown === undefined) continue;
    abandoned.push(chatId);
    startEmergencyLockdownRecovery(chatId, chatState.lockdown);
  }
  if (abandoned.length === 0) return;
  logger.error(
    "Anti-raid Worker gave up self-healing; main-thread emergency permission recovery started for chats: " +
    abandoned.join(", ")
  );
}

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
  persistedLockdownFingerprints.clear();
  for (const [chatId, chatState] of getAllChatStates()) {
    if (chatState.lockdown !== undefined) {
      persistedLockdownFingerprints.set(chatId, lockdownFingerprint(chatState.lockdown));
    }
  }
  const generation: number = nextAntiRaidGeneration();
  initAntiRaidWorker();
  post(buildAdoptVerificationsMessage(generation, true));
  const adopt: AdoptLockdownsMessage = buildAdoptMessage();
  if (adopt.lockdowns.length === 0) return;

  post(adopt);
  logger.log(`Adopted lockdowns still active from previous process exit: ${adopt.lockdowns.map((l) => l.chatId).join(", ")}`);
}

/** 统一群 teardown 入口：Worker 内取消验证并对 lockdown 发起可恢复解锁。 */
export function deactivateAntiRaidChat(chatId: number): void {
  post({ type: "deactivateChat", chatId });
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
      trackedMessageTimes: record.trackedMessageTimes === undefined ? undefined : [...record.trackedMessageTimes],
    });
    persistedVerificationRevisions.set(key, { generation: record.generation, revision: record.revision });
  }
}

/** 从 grammY 的 User 对象里摘出投递给 Worker 的最小身份字段。 */
function pickMember(user: { id: number; username?: string; first_name?: string; is_bot?: boolean }): AntiRaidMember {
  return { id: user.id, username: user.username, first_name: user.first_name, isBot: user.is_bot === true };
}

/** 某个 ChatMember 是否实际还在聊天中（相对于已离开/已被踢出而言）。 */
function isActiveChatMember(member: ChatMember): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.is_member;
  return true; // "member" | "administrator" | "creator"
}

/**
 * 处理 `chat_member` 更新：这是权威且始终会送达的入群/离群信号（不同于
 * `new_chat_members`/`left_chat_member` 服务消息——一旦群组开启了"隐藏入群/
 * 离群消息"，这些服务消息就完全不会再发送）。要接收非机器人自身成员的这类
 * 更新，需要机器人是群管理员——而封禁/删除消息本来也需要这个权限。
 */
export async function handleChatMemberUpdate(ctx: Context): Promise<void> {
  const update = ctx.chatMember;
  if (!update) return;

  const chatId: number = update.chat.id;
  const user = update.new_chat_member.user;
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

  // 管理员任免（含管理员入群/离群）同样以 chat_member 更新送达：同步给
  // Worker 侧的管理员表缓存，让「管理员拉人免验证」的同步判定近乎实时，
  // 缓存 TTL 只是兜底。FIFO 保证它先于随后的 join/left 投递生效。
  const wasAdmin: boolean = isAdminStatus(update.old_chat_member.status);
  const isAdmin: boolean = isAdminStatus(update.new_chat_member.status);
  const messages: AntiRaidWorkerMessage[] = [];
  if (wasAdmin !== isAdmin) messages.push({ type: "adminsChanged", chatId, userId: user.id, isAdmin });

  if (!wasActive && isActive) {
    // 以管理员/群主身份入群的（典型如群主退群重进）免验证。身份只有本路径
    // 可见，new_chat_members 服务消息里没有——所以不能简单跳过不投递，而要
    // 带 exempt 标记投给 Worker：若服务消息那一路已抢先开了验证窗口，Worker
    // 收到豁免后会将其撤销。
    messages.push({ type: "join", chatId, member: pickMember(user), exempt: isAdmin, actorId: update.from.id });
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

  if (message.new_chat_members && message.new_chat_members.length > 0) {
    const joins: AntiRaidWorkerMessage[] = [];
    for (const member of message.new_chat_members) {
      // 机器人不再豁免（走白名单用户代点验证的流程），只跳过本天才自己
      // ——自己既不能验证自己，也不该被自己踢出去。
      if (member.id === botId) continue;
      joins.push({ type: "join", chatId: message.chat.id, member: pickMember(member), announcementMessageId: message.message_id, actorId: message.from?.id });
    }
    if (joins.length > 0) await postAntiRaidDurably(joins);
    return true;
  }

  if (message.left_chat_member) {
    await postAntiRaidDurably([{ type: "left", chatId: message.chat.id, userId: message.left_chat_member.id }]);
    return false;
  }

  const userId: number | undefined = message.from?.id;
  const mayPrecedeJoinInCommentThread: boolean =
    message.reply_to_message?.is_automatic_forward === true ||
    message.message_thread_id !== undefined;
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
      isThreadReply: message.message_thread_id !== undefined,
    }]);
  }
  return false;
}

/**
 * 处理入群验证按钮的点击（callback_query）：解析出目标成员后整体投递给
 * Worker 应答与处理。前缀不匹配的 callback_query 与本模块无关，直接放过。
 */
export async function handleVerificationCallback(ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
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
