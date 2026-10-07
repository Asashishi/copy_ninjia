import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";

import { commandArgumentTokens } from "./arguments";
import type { CommandContext, Context } from "grammy";
import { BATCH_KICK_CONCURRENCY, BATCH_KICK_MAX_DURATION_MS, BATCH_KICK_MIN_DURATION_MS } from "../consts/commands";
import { TELEGRAM_DATE_UNIT_MS } from "../consts/telegram";

import {
  formatDurationCn,
  parseDurationTokenMs,
} from "../libs/durationToken";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { isUserBlocked } from "../infra/blocklist/membership";
import {
  requestBlocklistResweep,
  sweepBlockedMembers,
} from "../infra/blocklist/sweep";
import { readJoinLog } from "../infra/diskIO";
import { getChatState } from "../infra/storage/stateStore";
import { currentUpdateAbortSignal, throwIfUpdateAborted } from "../infra/updateContext";
import { batchKickChats } from "../cache/main/batchKick";
import { logger } from "../infra/logger";
import { readIdentityPolicyVerdicts } from "../infra/identityStorage";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../consts/identityStorage";
import type {
  BanChatMemberOutcome,
  KickChatMemberOutcome,
} from "../infra/telegram";
import {
  banChatMemberWithOutcome,
  kickChatMemberWithOutcome,
  probeChatMembership,
  sendCommandMessage,
} from "../infra/telegram";
import type { JoinLogRecord } from "../types/diskIO/storage";
import { runBoundedSettledBatch } from "../libs/boundedSettledBatch";
import type {
  BoundedBatchExecution,
  BoundedBatchResult,
} from "../libs/boundedSettledBatch";
import { rejectUnlessSuperAdmin } from "./commandActor";
import { submitDeferredCommand } from "./deferredCommands";
import type { CachedUser, ChatState } from "../types/chatState";
import type { IdentityPolicyVerdicts } from "../types/identityStorage";

interface BatchKickStats {
  kicked: number;
  absent: number;
  protected: number;
  blocked: number;
  forbidden: number;
  failed: number;
  /**
   * blocked 中本命令未做任何处置、交还给黑名单流程的条数：processJoinRecord 里命中
   * 黑名单后直接返回的分支。只用来决定整批结束后是否请求一次补扫；补封成功的
   * 记录不计入。
   */
  blockedHandoffs: number;
  /** 真正进入处置的记录条数；身份策略读取失败中断时小于总条数。 */
  scanned: number;
  /** 是否因身份策略读取失败提前中断；true 时剩余记录未处理。 */
  aborted: boolean;
  /** 批次途中本群不再受管而停止；true 时不发战报。 */
  unmanaged: boolean;
}

/** 把 `/batch_kick` 的单个 m/h/d 参数换算为毫秒数；须落在 BATCH_KICK_MIN_DURATION_MS 与 BATCH_KICK_MAX_DURATION_MS 之间，否则返回 undefined。 */
export function parseBatchKickDurationMs(token: string): number | undefined {
  const durationMs: number | undefined = parseDurationTokenMs(token);
  if (
    durationMs === undefined ||
    durationMs < BATCH_KICK_MIN_DURATION_MS ||
    durationMs > BATCH_KICK_MAX_DURATION_MS
  ) {
    return undefined;
  }
  return durationMs;
}

/**
 * 本群此刻是否仍归本命令处置：已初始化，且没有确证失去管理员身份。批次在后台与其它
 * update 交错执行，`/init disable`、机器人离群（purge 后不再是已初始化）与被撤管理员
 * 都会让它变为 false。
 */
function isBatchKickChatManaged(chatId: number): boolean {
  const state: Readonly<ChatState> = getChatState(chatId);
  return state.isInitEnabled === true && state.botPermissions?.isAdministrator !== false;
}

interface ProcessJoinRecordParams {
  chatId: number;
  record: JoinLogRecord;
  stats: BatchKickStats;
  /** 本块开始前直接冷读的永久策略结论；与实时缓存取并集判定是否跳过。 */
  verdicts: IdentityPolicyVerdicts;
}

/**
 * 处理单条日志：先确认仍在群（probeChatMembership），再调用只踢不封接口；
 * 顺序固定，`unbanChatMember` 对已封禁身份有解除封禁语义。
 */
async function processJoinRecord({
  chatId,
  record,
  stats,
  verdicts,
}: ProcessJoinRecordParams): Promise<void> {
  // isWhitelisted 已经把超级管理员算进白名单边界（whitelist.ts）。
  if (verdicts.whitelisted.has(record.userId) || isWhitelisted(record.userId)) {
    stats.protected++;
    return;
  }
  if (verdicts.blocked.has(record.userId) || isUserBlocked(record.userId)) {
    stats.blocked++;
    stats.blockedHandoffs++;
    return;
  }
  const present: boolean | undefined = await probeChatMembership(
    chatId,
    record.userId
  );
  if (present === false) {
    stats.absent++;
    return;
  }
  if (present === undefined) {
    stats.failed++;
    return;
  }
  // membership 探测与只踢请求之间可能并发执行 `/block`：这里做第二次同步判定，
  // 请求完成后再判一次并补封，先写内存名单的永久封禁最终生效。
  if (isUserBlocked(record.userId)) {
    stats.blocked++;
    stats.blockedHandoffs++;
    return;
  }
  // 本命令入口只接受超级群（见 handleBatchKickCommand），isSupergroup 传 true。
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId,
    userId: record.userId,
    isSupergroup: true,
  });
  // 网络失败也可能发生在 Telegram 已执行 unban 之后；只要权威名单已变为 blocked，
  // 不论 outcome 都补封。
  if (isUserBlocked(record.userId)) {
    const restored: BanChatMemberOutcome = await banChatMemberWithOutcome(
      chatId,
      record.userId
    );
    if (restored === "banned") {
      stats.blocked++;
      return;
    }
    requestBlocklistResweep(chatId);
    try {
      await sweepBlockedMembers(chatId);
    } catch (error: unknown) {
      // durable outbox 已经保留重放依据；命令战报仍按失败结算并留下原因。
      logger.error(
        `Failed to dispatch the blocklist repair after /batch_kick in chat ${chatId}:`,
        error
      );
    }
    stats.failed++;
    return;
  }
  if (outcome === "kicked") {
    stats.kicked++;
  } else if (outcome === "absent") {
    stats.absent++;
  } else if (outcome === "forbidden") {
    stats.forbidden++;
  } else {
    stats.failed++;
  }
}

interface RunBatchKickParams {
  chatId: number;
  records: readonly JoinLogRecord[];
}

/**
 * 按 BATCH_KICK_CONCURRENCY 并发消费日志，每块 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES 条；
 * 每条结果保留输入下标，意外异常不截断其余记录。429 退避由 Telegram 总闸负责，
 * 这里不重试。
 *
 * 每块开始前经 readIdentityPolicyVerdicts 直接读取本块全部身份的永久策略结论并局部
 * 持有，与消费逐块交错；白名单与黑名单判定取「局部结论 ∪ 实时缓存」。读取失败
 * （返回 null）时就地中断并置 aborted，剩余记录不处理。
 *
 * 停机取消本条任务后，尚未开始的记录不再处理，在途记录因取消而失败的结果不计入
 * 战报也不记日志；每块开始前与结束后各检查一次，取消即向上解开整条任务。本群途中
 * 不再受管时同样不再处理尚未开始的记录，标记 `unmanaged` 后返回。
 */
async function runBatchKick({
  chatId,
  records,
}: RunBatchKickParams): Promise<BatchKickStats> {
  const stats: BatchKickStats = {
    kicked: 0,
    absent: 0,
    protected: 0,
    blocked: 0,
    forbidden: 0,
    failed: 0,
    blockedHandoffs: 0,
    scanned: 0,
    aborted: false,
    unmanaged: false,
  };
  const updateSignal: AbortSignal | undefined = currentUpdateAbortSignal();
  for (
    let offset: number = 0;
    offset < records.length;
    offset += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    throwIfUpdateAborted(updateSignal);
    if (!isBatchKickChatManaged(chatId)) {
      stats.unmanaged = true;
      return stats;
    }
    const chunk: readonly JoinLogRecord[] = records.slice(
      offset,
      offset + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
    );
    const verdicts: IdentityPolicyVerdicts | null = await readIdentityPolicyVerdicts(
      chunk.map((record: JoinLogRecord): number => record.userId)
    );
    if (verdicts === null) {
      stats.aborted = true;
      return stats;
    }
    const results: BoundedBatchResult<JoinLogRecord, void>[] =
      await runBoundedSettledBatch<JoinLogRecord, void>({
        items: chunk,
        maxConcurrent: BATCH_KICK_CONCURRENCY,
        execute: async ({
          item: record,
        }: BoundedBatchExecution<JoinLogRecord>): Promise<void> => {
          if (updateSignal?.aborted === true || !isBatchKickChatManaged(chatId)) return;
          await processJoinRecord({ chatId, record, stats, verdicts });
        },
      });
    throwIfUpdateAborted(updateSignal);
    if (!isBatchKickChatManaged(chatId)) {
      stats.unmanaged = true;
      return stats;
    }
    stats.scanned += chunk.length;
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      stats.failed++;
      logger.error(
        `Unexpected /batch_kick failure for chat ${chatId}, user ${result.item.userId}, ` +
        `record ${offset + result.index}:`,
        result.reason
      );
    }
  }
  return stats;
}

interface DeliverBatchKickParams {
  readonly chatId: number;
  readonly messageId: number | undefined;
  readonly durationMs: number;
  readonly records: readonly JoinLogRecord[];
  /** 「已受理」回执发完（或发送结束）后兑现；批次在它之后开始，保证战报排在回执之后。 */
  readonly acknowledged: Promise<void>;
}

/**
 * 延迟命令执行器里的批次任务：逐条处置、交回黑名单、按 NOTICE_TEXTS.batchKickResult 发战报。
 * 本群途中不再受管时静默结束，不发战报；停机取消由执行器吞掉。结束时摘除单飞标记。
 */
async function deliverBatchKick({
  chatId,
  messageId,
  durationMs,
  records,
  acknowledged,
}: DeliverBatchKickParams): Promise<void> {
  try {
    await acknowledged;
    const stats: BatchKickStats = await runBatchKick({ chatId, records });
    if (stats.unmanaged) return;
    if (stats.aborted && stats.scanned === 0) {
      await sendCommandMessage({
        chatId,
        text: chatAtmosphere().IDENTITY_POLICY_UNAVAILABLE_TEXT,
        replyToMessageId: messageId,
      });
      return;
    }
    // processJoinRecord 对命中黑名单的记录直接返回，不探测、不移除；回执渲染成
    // 「黑名单交回封禁」，这里把它们真正交回：整批只派发一次补扫
    // （requestBlocklistResweep + sweepBlockedMembers）。只看 blockedHandoffs，
    // 并发拉黑后补封成功的记录不触发。
    if (stats.blockedHandoffs > 0) {
      requestBlocklistResweep(chatId);
      try {
        await sweepBlockedMembers(chatId);
      } catch (error: unknown) {
        // durable outbox 已经保留重放依据；战报照常发出，原因留在日志里。
        logger.error(
          `Failed to dispatch the blocklist sweep after /batch_kick in chat ${chatId}:`,
          error
        );
      }
    }
    throwIfUpdateAborted();
    if (!isBatchKickChatManaged(chatId)) return;
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId,
      text:
        atmosphere.NOTICE_TEXTS.batchKickResult({ duration: formatDurationCn(durationMs), recordCount: records.length, scanned: stats.scanned, kicked: stats.kicked, absent: stats.absent, protected: stats.protected, blocked: stats.blocked, forbidden: stats.forbidden, failed: stats.failed, abortedNotice: (stats.aborted
          ? atmosphere.NOTICE_TEXTS.batchKickAborted
          : "") }),
      replyToMessageId: messageId,
    });
  } finally {
    batchKickChats.delete(chatId);
  }
}

/**
 * `/batch_kick <Nm|Nh|Nd>`：只允许超级管理员在超级群中执行；初始化状态由
 * app/registerHandlers.ts 的统一前置网关保证，本 handler 不重复判断或提示。
 * 按需读取本群入群追写日志中回溯窗口覆盖的记录，并踢出窗口内仍在群的人。
 * 本命令不新增黑名单持久化；与并发 `/block` 冲突、或日志里的人本来就在黑名单上
 * 时，本命令不自己处置，而是在整批结束后请一次补扫，把他们真正交回封禁流程。
 *
 * handler 只做校验与读日志：有记录时同群单飞，交给延迟命令执行器的 background 档后
 * 回「已受理」，批次与战报在后台任务里完成（见 deliverBatchKick）。
 */
export async function handleBatchKickCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessSuperAdmin(
    ctx,
    (_actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.batchKickRejected
  );
  if (actor === undefined) return;
  if (ctx.chat.type !== "supergroup") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().NOTICE_TEXTS.batchKickSupergroupOnly,
      replyToMessageId: messageId,
    });
    return;
  }
  const tokens: string[] = commandArgumentTokens(ctx.match);
  const durationMs: number | undefined = tokens.length === 1
    ? parseBatchKickDurationMs(tokens[0]!)
    : undefined;
  if (durationMs === undefined) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().BATCH_KICK_USAGE_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }

  // 同群单飞在读日志之前判定：上一批还在后台跑时不读盘。
  if (batchKickChats.has(chatId)) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().NOTICE_TEXTS.batchKickRunning,
      replyToMessageId: messageId,
    });
    return;
  }

  // 窗口的「现在」取本条命令自带的 Telegram 时间戳，与 joinedAt（来自 `update.date`，
  // 见 antiRaid/updateIngress.ts）同源；`readJoinLog` 用 since/now 比对 joinedAt，
  // 并据此计算窗口覆盖的日文件。
  //
  // 文件保留期按宿主时钟判（见 readJoinLog 里的 today），与事件时间无关。
  const now: number = ctx.msg.date * TELEGRAM_DATE_UNIT_MS;
  let records: readonly JoinLogRecord[];
  try {
    records = await readJoinLog({
      chatId,
      since: now - durationMs,
      now,
    });
  } catch (error: unknown) {
    logger.error(
      `Failed to read join logs for /batch_kick in chat ${chatId}:`,
      error
    );
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().NOTICE_TEXTS.joinLogUnavailable,
      replyToMessageId: messageId,
    });
    return;
  }

  if (records.length === 0) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().NOTICE_TEXTS.batchKickEmpty(formatDurationCn(durationMs)),
      replyToMessageId: messageId,
    });
    return;
  }

  const acknowledged: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  // 先登记再提交：执行器可能在提交的同步段里就启动任务。
  batchKickChats.add(chatId);
  const accepted: boolean = submitDeferredCommand({
    priority: "background",
    task: (): Promise<void> => deliverBatchKick({ chatId, messageId, durationMs, records, acknowledged: acknowledged.promise }),
    errorLabel: "Unexpected error while processing /batch_kick:",
  });
  if (!accepted) {
    batchKickChats.delete(chatId);
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().NOTICE_TEXTS.batchKickBusy,
      replyToMessageId: messageId,
    });
    return;
  }
  try {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().NOTICE_TEXTS.batchKickAccepted({
        duration: formatDurationCn(durationMs),
        recordCount: records.length,
      }),
      replyToMessageId: messageId,
    });
  } finally {
    acknowledged.resolve();
  }
}
