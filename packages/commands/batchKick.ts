import type { CommandContext, Context } from "grammy";
import {
  BATCH_KICK_CONCURRENCY,
  BATCH_KICK_MAX_DURATION_MS,
  BATCH_KICK_MIN_DURATION_MS,
} from "../consts/commands";
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
import { readRecentJoinLog } from "../infra/joinLog";
import { logger } from "../infra/logger";
import { prefetchIdentityPolicies } from "../infra/identityStorage";
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
  /**
   * 其中「本命令一步都没做、纯粹交还给黑名单流程」的条数：命中黑名单后直接
   * 早退的那两条分支。不进战报（对管理员而言它们都是「黑名单交回封禁」），
   * 只用来决定整批结束后要不要真的请一次补扫——补封成功那条路已经自己把人
   * 按住了，不该再白白惊动清扫。
   */
  blockedHandoffs: number;
  /** 真正进入处置的记录条数；身份预取失败中断时小于总条数。 */
  scanned: number;
  /** 是否因为身份冷读失败提前中断；true 时剩余记录一个都没动过。 */
  aborted: boolean;
}

/** 把 `/batch_kick` 的单个 m/h/d 参数严格换算为一天以内的毫秒数。 */
export function parseBatchKickDurationMs(token: string): number | undefined {
  const durationMs: number | undefined = parseDurationTokenMs(token);
  if (
    durationMs === undefined ||
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
  return formatDurationCn(durationMs);
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
  // isWhitelisted 已经把超级管理员算进白名单边界（whitelist.ts）。
  if (isWhitelisted(record.userId)) {
    stats.protected++;
    return;
  }
  if (isUserBlocked(record.userId)) {
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
  // membership 探测与只踢请求之间仍可能并发执行 `/block`。第二次同步判定缩小
  // 窗口；请求完成后再判一次并补封，保证先写内存名单的永久封禁最终获胜。
  if (isUserBlocked(record.userId)) {
    stats.blocked++;
    stats.blockedHandoffs++;
    return;
  }
  // 本命令在入口就只接受超级群（见 handleBatchKickCommand），如实传 true 而不是
  // 留空：这样各调用点交给同一个封装的都是同一种对象 shape。
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId,
    userId: record.userId,
    isSupergroup: true,
  });
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
 * 用固定小并发消费日志；每条结果保留输入下标，意外异常不会截断其余记录。
 * Telegram 总闸已经负责 429 的有限退避，这里不再套一层重复踢人重试。
 *
 * 身份预取与消费必须**逐块交错**，且每块严格小于身份 LRU 容量：一次把上万条
 * 记录全部预取完的话，前面的块早被后面的块整块挤出缓存，轮到它们时
 * `isWhitelisted` 冷未命中会把白名单管理员/频道身份当普通成员踢出去，黑名单
 * 成员也会绕过黑名单流程被静默踢掉（见 consts/identityStorage.ts 的
 * IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES）。冷读失败同样不能按「不在白名单」处置，
 * 只能就地中断，剩余记录一条都不碰。
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
  };
  for (
    let offset: number = 0;
    offset < records.length;
    offset += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    const chunk: readonly JoinLogRecord[] = records.slice(
      offset,
      offset + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
    );
    const prefetched: boolean = await prefetchIdentityPolicies(
      chunk.map((record: JoinLogRecord): number => record.userId)
    );
    if (!prefetched) {
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
          await processJoinRecord({ chatId, record, stats });
        },
      });
    stats.scanned += chunk.length;
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      stats.failed++;
      logger.error(
        `Unexpected /batch_kick failure for chat ${chatId}, user ${result.item.userId}, ` +
        `record ${offset + result.index}, attempt ${result.attempt}:`,
        result.reason
      );
    }
  }
  return stats;
}

/**
 * `/batch_kick <Nm|Nh|Nd>`：只允许超级管理员在超级群中执行；初始化状态由
 * app/registerHandlers.ts 的统一前置网关保证，本 handler 不重复判断或提示。
 * 按需读取本群滚动 24 小时入群追写日志，并踢出回溯窗口内仍在群的人。
 * 本命令不新增黑名单持久化；与并发 `/block` 冲突、或日志里的人本来就在黑名单上
 * 时，本命令不自己处置，而是在整批结束后请一次补扫，把他们真正交回封禁流程。
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

  // 窗口的「现在」取本条命令自带的 Telegram 时间戳，不是宿主的 Date.now()：
  // 库里那些 joinedAt 全都来自 `update.date`（见 antiRaid/updateIngress.ts），
  // 两个时钟直接相减的话，窗口边界会整体漂移出它们之间的偏差——`readJoinLog`
  // 既拿 since/now 逐条比 joinedAt，也拿它们算该读哪一两个日文件（那些文件名
  // 同样是按 joinedAt 的东京日期起的）。同源之后这两步与写入侧用的是同一把尺。
  //
  // 文件保留期那侧仍按宿主时钟判（见 readJoinLog 里的 today）：那问的是「盘上
  // 还剩哪几天」，由 Worker 自己的跨日清理决定，与事件时间无关。
  const now: number = ctx.msg.date * 1000;
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
  if (stats.aborted && stats.scanned === 0) {
    await sendCommandMessage({
      chatId,
      text: "呜……黑白名单暂时读不出来，本次一个人都没动，稍后再试吧♡",
      replyToMessageId: messageId,
    });
    return;
  }
  // 命中黑名单就直接早退的那几条，processJoinRecord 一步都没做——不探测、不移除，
  // 回执却渲染成「黑名单交回封禁 N」。不在这里真的交回去，那句话就是空的：管理员
  // 据此认为黑名单流程接手了，实际没有任何批次、清扫或重试存在。典型成因正是更早
  // 的封禁批次在限流下被判 complete 而实际没生效，人还坐在群里。
  // 只看 blockedHandoffs：并发拉黑后补封成功那条路已经把人按住了，不必再惊动清扫。
  // 整批只派发一次：prepareBlocklistSweep 自带 claim 与 nextRetryAt 闸门，逐条
  // 调用只是空转，还要在命令的固定小并发池里排队。
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
  await sendCommandMessage({
    chatId,
    text:
      `已扫描最近 ${formatBatchKickDuration(durationMs)} 的 ${records.length} 条入群记录中的 ${stats.scanned} 条：` +
      `踢出 ${stats.kicked}，已不在群 ${stats.absent}，自己人跳过 ${stats.protected}，` +
      `黑名单交回封禁 ${stats.blocked}，` +
      `权限不足 ${stats.forbidden}，查询或请求失败 ${stats.failed}。只踢未拉黑♡` +
      (stats.aborted
        ? "\n中途黑白名单读不出来了，剩下的记录一条都没动，稍后再跑一次吧♡"
        : ""),
    replyToMessageId: messageId,
  });
}
