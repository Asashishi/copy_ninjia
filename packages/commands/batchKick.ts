import type { CommandContext, Context } from "grammy";
import {
  BATCH_KICK_CONCURRENCY,
  BATCH_KICK_DURATION_ARG_PATTERN,
  BATCH_KICK_DURATION_UNIT_MS,
  BATCH_KICK_MAX_DURATION_MS,
  BATCH_KICK_MIN_DURATION_MS,
} from "../consts/commands";
import { isWhitelisted } from "../config/whitelist";
import { isUserBlocked } from "../infra/blocklist/membership";
import {
  requestBlocklistResweep,
  sweepBlockedMembers,
} from "../infra/blocklist/sweep";
import { SUPER_ADMIN_USER_ID } from "../infra/config";
import { readRecentJoinLog } from "../infra/joinLog";
import { logger } from "../infra/logger";
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
import { isSuperAdminActor } from "./commandActor";

const BATCH_KICK_USAGE_TEXT: string =
  "笨蛋，/batch_kick 后面只带一个回溯时长：数字加 m/h/d，比如 30m、2h、1d；" +
  "最多回溯滚动 24 小时。这个命令只踢人，不会加入黑名单♡";

interface BatchKickStats {
  kicked: number;
  absent: number;
  protected: number;
  blocked: number;
  forbidden: number;
  failed: number;
}

/** 把 `/batch_kick` 的单个 m/h/d 参数严格换算为一天以内的毫秒数。 */
export function parseBatchKickDurationMs(token: string): number | undefined {
  const match: RegExpExecArray | null = BATCH_KICK_DURATION_ARG_PATTERN.exec(token);
  if (match === null) return undefined;
  const value: number = Number(match[1]!);
  const unit: "m" | "h" | "d" =
    match[2]!.toLowerCase() as "m" | "h" | "d";
  const durationMs: number = value * BATCH_KICK_DURATION_UNIT_MS[unit];
  if (
    !Number.isFinite(durationMs) ||
    durationMs < BATCH_KICK_MIN_DURATION_MS ||
    durationMs > BATCH_KICK_MAX_DURATION_MS
  ) {
    return undefined;
  }
  return durationMs;
}

/** 把已校验的回溯时长转换成战报文案。 */
export function formatBatchKickDuration(durationMs: number): string {
  if (durationMs % BATCH_KICK_DURATION_UNIT_MS.d === 0) {
    return `${durationMs / BATCH_KICK_DURATION_UNIT_MS.d} 天`;
  }
  if (durationMs % BATCH_KICK_DURATION_UNIT_MS.h === 0) {
    return `${durationMs / BATCH_KICK_DURATION_UNIT_MS.h} 小时`;
  }
  return `${durationMs / BATCH_KICK_DURATION_UNIT_MS.m} 分钟`;
}

interface ProcessJoinRecordParams {
  chatId: number;
  record: JoinLogRecord;
  stats: BatchKickStats;
}

/**
 * 处理单条日志：先确认仍在群，再调用只踢不封接口。这个顺序不能省略，
 * `unbanChatMember` 对已封禁身份有解除封禁语义，盲打会把历史封禁意外放开。
 */
async function processJoinRecord({
  chatId,
  record,
  stats,
}: ProcessJoinRecordParams): Promise<void> {
  if (
    record.userId === SUPER_ADMIN_USER_ID ||
    isWhitelisted(record.userId)
  ) {
    stats.protected++;
    return;
  }
  if (isUserBlocked(record.userId)) {
    stats.blocked++;
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
  // membership 探测与只踢请求之间仍可能并发执行 `/block`。第二次同步判定缩小
  // 窗口；请求完成后再判一次并补封，保证先写内存名单的永久封禁最终获胜。
  if (isUserBlocked(record.userId)) {
    stats.blocked++;
    return;
  }
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome(
    chatId,
    record.userId
  );
  // 网络失败也可能发生在 Telegram 已执行 unban 之后，因此不能只在明确
  // "kicked" 时补查；只要权威名单已变为 blocked，就一律把永久封禁补回。
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

/** 用固定小并发消费日志，避免大批量请求同时冲击 Telegram Bot API。 */
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
  };
  let nextIndex: number = 0;
  const workerCount: number = Math.min(
    BATCH_KICK_CONCURRENCY,
    records.length
  );
  const workers: Promise<void>[] = [];
  for (let i: number = 0; i < workerCount; i++) {
    workers.push((async (): Promise<void> => {
      while (nextIndex < records.length) {
        const index: number = nextIndex++;
        await processJoinRecord({
          chatId,
          record: records[index]!,
          stats,
        });
      }
    })());
  }
  await Promise.all(workers);
  return stats;
}

/**
 * `/batch_kick <Nm|Nh|Nd>`：只允许超级管理员在超级群中执行；初始化状态由
 * app/registerHandlers.ts 的统一前置网关保证，本 handler 不重复判断或提示。
 * 按需读取本群滚动 24 小时入群追写日志，并踢出回溯窗口内仍在群的人。
 * 本命令不新增黑名单持久化；与并发 `/block` 冲突时会把成员交回既有封禁流程。
 */
export async function handleBatchKickCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (!isSuperAdminActor(ctx)) {
    await sendCommandMessage({
      chatId,
      text: "就你也想批量踢人？/batch_kick 只听超级管理员本人的，杂鱼退散啦♡",
      replyToMessageId: messageId,
    });
    return;
  }
  if (ctx.chat.type !== "supergroup") {
    await sendCommandMessage({
      chatId,
      text: "笨蛋，/batch_kick 只能在超级群里使用♡",
      replyToMessageId: messageId,
    });
    return;
  }
  const tokens: string[] = ctx.match
    .trim()
    .split(/\s+/)
    .filter((token: string): boolean => token.length > 0);
  const durationMs: number | undefined = tokens.length === 1
    ? parseBatchKickDurationMs(tokens[0]!)
    : undefined;
  if (durationMs === undefined) {
    await sendCommandMessage({
      chatId,
      text: BATCH_KICK_USAGE_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }

  const now: number = Date.now();
  let records: readonly JoinLogRecord[];
  try {
    records = await readRecentJoinLog({
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
      text: "呜……入群日志暂时读不了，本次一个人都没动，稍后再试吧♡",
      replyToMessageId: messageId,
    });
    return;
  }

  if (records.length === 0) {
    await sendCommandMessage({
      chatId,
      text: `最近 ${formatBatchKickDuration(durationMs)} 没有记录到新成员，本次没有踢人，也没有写入黑名单♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const stats: BatchKickStats = await runBatchKick({ chatId, records });
  await sendCommandMessage({
    chatId,
    text:
      `已扫描最近 ${formatBatchKickDuration(durationMs)} 的 ${records.length} 条入群记录：` +
      `踢出 ${stats.kicked}，已不在群 ${stats.absent}，自己人跳过 ${stats.protected}，` +
      `黑名单交回封禁 ${stats.blocked}，` +
      `权限不足 ${stats.forbidden}，查询或请求失败 ${stats.failed}。只踢未拉黑♡`,
    replyToMessageId: messageId,
  });
}
