import type {
  InlineQuery,
  InlineQueryResultArticle,
  Message,
  MessageEntity,
} from "@grammyjs/types";
import {
  InlineQueryResultBuilder,
  type Context,
} from "grammy";
import { gagSessionsByChat } from "../../cache/main/gag";
import {
  GAG_INLINE_CHANNEL_LINK_PREFIX,
  GAG_INLINE_LABEL_MAX_CHARS,
  GAG_INLINE_QUERY_PREFIX,
} from "../../consts/gag";
import { getGagThumbnailUrl } from "../../infra/storage/stateStore";
import {
  deleteMessageWithOutcome,
  logApiError,
} from "../../infra/telegram";
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../../infra/updateContext";
import { truncateInline } from "../../libs/text";
import type {
  GagSession,
  ParsedGagInlineQuery,
} from "../../types/gag";
import {
  gagSpeechPrefix,
  parseGagInlineQuery,
  renderGagSpeech,
} from "./rendering";
import {
  deleteGagSpeakNotice,
  sendGagSpeakNotice,
} from "./notices";
import { collectDueGagSpeakNotices } from "./counter";
import {
  expireGag,
  findGagSession,
  finishGag,
  trackGagBackgroundTask,
} from "./runtime";

/** deleted/gone 都表示该入口不再可见，可以安全释放其唯一 id 槽位。 */
function gagNoticeDeletionFinished(
  outcome: Awaited<ReturnType<typeof deleteGagSpeakNotice>>
): boolean {
  return outcome === "deleted" || outcome === "gone";
}

/** 只把纯文本或带 caption 的媒体视作 gag 应删除的文字消息。 */
function hasGagDeletableText(message: Message): boolean {
  return typeof message.text === "string" ||
    typeof message.caption === "string";
}

/** 删除上一次换新遗留的旧入口；失败时保留固定单槽位，禁止继续堆新入口。 */
async function retryRetiredGagSpeakNotice(
  session: GagSession
): Promise<boolean> {
  const retiredId: number = session.retiredSpeakNoticeMessageId;
  if (retiredId === 0) return true;
  const outcome: Awaited<ReturnType<typeof deleteGagSpeakNotice>> =
    await deleteGagSpeakNotice(session, retiredId);
  const finished: boolean = gagNoticeDeletionFinished(outcome);
  if (
    finished &&
    session.retiredSpeakNoticeMessageId === retiredId
  ) session.retiredSpeakNoticeMessageId = 0;
  return finished;
}

/**
 * 发出本会话的新入口，再原子切换 current/pending/retired 三个固定槽位，最后
 * 删除旧入口。onSent 必须先写 pending：停机 abort 即使带走返回值，ending 仍
 * 能按精确目标身份回收远端已经建立的入口。
 */
async function replaceGagSpeakNotice(session: GagSession): Promise<void> {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "active"
  ) return;
  const recordPending = (noticeMessageId: number): void => {
    session.pendingSpeakNoticeMessageId = noticeMessageId;
  };
  const noticeMessageId: number | undefined = await sendGagSpeakNotice({
    session,
    onSent: recordPending,
  });
  if (noticeMessageId === undefined) {
    // API 失败已经由统一 Telegram 边界记录；隔 15 条消息再试，避免每条消息
    // 都打一次失败请求。
    session.messagesSinceSpeakNotice = 0;
    return;
  }
  session.pendingSpeakNoticeMessageId = noticeMessageId;
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "active"
  ) return;
  const previousNoticeMessageId: number = session.speakNoticeMessageId;
  session.speakNoticeMessageId = noticeMessageId;
  session.pendingSpeakNoticeMessageId = 0;
  session.retiredSpeakNoticeMessageId =
    previousNoticeMessageId === noticeMessageId
      ? 0
      : previousNoticeMessageId;
  session.messagesSinceSpeakNotice = 0;
  if (session.retiredSpeakNoticeMessageId === 0) return;
  await retryRetiredGagSpeakNotice(session);
}

/** 同一会话只允许一条换新任务；timer/teardown 可通过字段等待并接管所有 id。 */
async function refreshGagSpeakNotice(session: GagSession): Promise<void> {
  const existing: Promise<void> | null = session.speakNoticeRefreshTask;
  if (existing !== null) return existing;
  const task: Promise<void> = replaceGagSpeakNotice(session);
  session.speakNoticeRefreshTask = task;
  try {
    await task;
  } finally {
    if (session.speakNoticeRefreshTask === task) {
      session.speakNoticeRefreshTask = null;
    }
  }
}

/** 只处理已经命中阈值的会话；常态计数路径不进入 async，避免额外 Promise。 */
async function refreshDueGagSpeakNotices(
  due: readonly GagSession[]
): Promise<void> {
  for (const session of due) {
    if (
      findGagSession(session.chatId, session.targetId) !== session ||
      session.phase !== "active" ||
      session.expiresAt <= Date.now()
    ) continue;
    if (session.retiredSpeakNoticeMessageId !== 0) {
      const retiredFinished: boolean =
        await retryRetiredGagSpeakNotice(session);
      if (!retiredFinished) {
        session.messagesSinceSpeakNotice = 0;
        continue;
      }
    }
    await refreshGagSpeakNotice(session);
  }
}

/** 当前 bot 消息是否带有频道 gag 身份标记。 */
function hasGagInlineMarker(message: Message, botId: number): boolean {
  if (message.via_bot?.id !== botId) return false;
  return message.entities?.some((entity: MessageEntity): boolean =>
    entity.type === "text_link" &&
    entity.url.startsWith(GAG_INLINE_CHANNEL_LINK_PREFIX)
  ) === true;
}

/** 当前 bot inline 文本是否匹配用具，且频道目标同时匹配标记 id。 */
function isCurrentGagInlineMessage(
  message: Message,
  botId: number,
  session: GagSession
): boolean {
  if (
    message.via_bot?.id !== botId ||
    typeof message.text !== "string"
  ) return false;
  const prefix: string = gagSpeechPrefix(session.tool);
  if (!message.text.startsWith(prefix)) return false;
  if (session.targetId > 0) return true;
  const markerUrl: string =
    `${GAG_INLINE_CHANNEL_LINK_PREFIX}${session.targetId}`;
  return message.entities?.some((entity: MessageEntity): boolean =>
    entity.type === "text_link" &&
    entity.offset === 0 &&
    entity.length === prefix.length &&
    entity.url === markerUrl
  ) === true;
}

/** 当前 bot 消息是否看起来在使用本群 gag 入口，但尚未通过完整身份校验。 */
function isGagInlineCandidate(
  message: Message,
  botId: number,
  sessions: readonly GagSession[]
): boolean {
  if (message.via_bot?.id !== botId) return false;
  if (typeof message.text !== "string") return false;
  for (const session of sessions) {
    if (
      session.phase === "active" &&
      message.text.startsWith(gagSpeechPrefix(session.tool))
    ) return true;
  }
  return false;
}

/** 在本群小列表中定位当前发送身份的活动会话，不为每条消息创建 find 回调。 */
function findActiveGagSenderSession(
  sessions: readonly GagSession[],
  senderId: number | undefined
): GagSession | undefined {
  if (senderId === undefined) return undefined;
  for (const candidate of sessions) {
    if (
      candidate.targetId === senderId &&
      candidate.phase === "active"
    ) return candidate;
  }
  return undefined;
}

/**
 * 命令前的消息入口：活动目标的任何消息都被认领；频道 gag inline 结果只有标记
 * 频道 ID 与最终 sender_chat.id 同时匹配才放行，用户则核对 from.id。
 */
export async function handleGagMessageIngress(
  message: Message,
  botId: number
): Promise<boolean> {
  const hasMarker: boolean = hasGagInlineMarker(message, botId);
  // 无活动会话时仍拦带标记的旧结果；普通消息只付一次 via_bot 判定。
  if (gagSessionsByChat.size === 0) {
    if (!hasMarker) return false;
    await deleteMessageWithOutcome(message.chat.id, message.message_id);
    return true;
  }
  const sessions: GagSession[] | undefined =
    gagSessionsByChat.get(message.chat.id);
  const senderId: number | undefined =
    message.sender_chat?.id ?? message.from?.id;
  if (sessions === undefined) {
    if (!hasMarker) return false;
    await deleteMessageWithOutcome(message.chat.id, message.message_id);
    return true;
  }
  const session: GagSession | undefined = findActiveGagSenderSession(
    sessions,
    senderId
  );
  const isGagInlineMessage: boolean = session !== undefined &&
    isCurrentGagInlineMessage(message, botId, session);
  const now: number = Date.now();
  const hasDeletableText: boolean = hasGagDeletableText(message);
  const isDeletedGagTargetMessage: boolean =
    session !== undefined &&
    session.expiresAt > now &&
    !isGagInlineMessage &&
    hasDeletableText;
  if (!isDeletedGagTargetMessage) {
    // 会被 gag 删除的目标消息不进入任何入口的 15 条窗口；通过按钮的发言和
    // 允许保留的无文字媒体仍是群内可见消息。常态只原地更新定长小数组。
    const due: GagSession[] | null = collectDueGagSpeakNotices(
      sessions,
      now
    );
    // 入口换新只是维护动作，绝不能在这条 ingress 里 await：本 handler 注册在所有
    // 命令之前，而 update 循环一次只取一条 update 并完整等待（app/updateRunner.ts）。
    // 一旦 message/delete 车道处在 429 退避，enqueueOrStart 会把这次发送/删除停到
    // retry_after（infra/telegram/outboundGate.ts），期间**任何群的任何 update**
    // 都不再被处理。交给统一的 gag 后台任务集合，停机由 drainGagRuntime 有界排空。
    // 换新任务自己会重新核对会话仍是当前 active 会话，并由 speakNoticeRefreshTask
    // 保证同一会话只有一条在途。
    if (due !== null) {
      trackGagBackgroundTask(
        refreshDueGagSpeakNotices(due),
        "Unexpected error while refreshing a gag speak notice:"
      );
    }
  }
  const isCandidate: boolean = hasMarker || isGagInlineCandidate(
    message,
    botId,
    sessions
  );
  if (session === undefined) {
    if (!isCandidate) return false;
    if (!hasDeletableText) return false;
    await deleteMessageWithOutcome(message.chat.id, message.message_id);
    return true;
  }
  if (session.expiresAt <= Date.now()) {
    await finishGag(session, "timeout");
    if (isCandidate && hasDeletableText) {
      await deleteMessageWithOutcome(message.chat.id, message.message_id);
      return true;
    }
    return false;
  }
  if (isGagInlineMessage && senderId === session.targetId) return false;
  if (!hasDeletableText) return false;
  await deleteMessageWithOutcome(message.chat.id, message.message_id);
  return true;
}

/** 为一条活动会话建立身份专属 inline article。 */
function buildGagInlineResult(
  session: GagSession,
  query: string
): InlineQueryResultArticle {
  const chatLabel: string = truncateInline(
    session.chatLabel,
    GAG_INLINE_LABEL_MAX_CHARS
  );
  const toolLabel: string = truncateInline(
    session.tool,
    GAG_INLINE_LABEL_MAX_CHARS
  );
  const messageText: string = renderGagSpeech({
    text: query,
    tool: session.tool,
  });
  const prefixLength: number = gagSpeechPrefix(session.tool).length;
  const entities: MessageEntity[] = session.targetId < 0
    ? [{
      type: "text_link",
      offset: 0,
      length: prefixLength,
      url: `${GAG_INLINE_CHANNEL_LINK_PREFIX}${session.targetId}`,
    }]
    : [];
  return InlineQueryResultBuilder.article(
    `gag-${session.chatId}-${session.targetId}`,
    `在 ${chatLabel} 发言`,
    {
      description: `透过${toolLabel}`,
      thumbnail_url: getGagThumbnailUrl(),
    }
  ).text(messageText, {
    ...(entities.length === 0 ? {} : { entities }),
    link_preview_options: { is_disabled: true },
  });
}

/**
 * gag / 运势 inline 协议（不得合并入口）：
 * 1. 无 `gag:` 前缀时必须返回 false，即使查询者正被 gag，也只允许下游运势应答；
 * 2. `gag: <正文>` 只来自普通用户的目标专属按钮，按 `from.id` 匹配用户会话；
 * 3. `gag:<负数频道 id>:<会话令牌> <正文>` 只定位频道会话，令牌必须与该会话一致，
 *    发送落群后再核对 sender_chat；
 * 4. 任何带 `gag:` 的查询都由本函数终止分发；非法、过期或身份不匹配时回空，
 *    绝不能回退运势或同时生成两类结果。
 *
 * 频道分支为什么必须校验令牌：普通用户按 `from.id` 绑定，而频道皮套背后是谁
 * Telegram 从不告知，只比对频道 id 等于不作校验——任意账号发一条
 * `@bot gag:<频道 id> x` 就能拿到用 `session.chatLabel` 拼出的「在 <群名称>
 * 发言」，把私有群标题读走。令牌只随群内那条带按钮的开始提示分发，因此持有它
 * 就等价于「看得见这个入口」（见 consts/gag.ts 的 GAG_INLINE_TOKEN_BYTES）。
 *
 * 不做分页：GAG_SESSION_MAX 是**跨全部群**的全局上限（见 gag/runtime.ts 的
 * reserveGagSession），远小于单次 answerInlineQuery 的 50 条上限，而每条查询最多
 * 只匹配一条会话（用户按 from.id、频道按 id+令牌，都是唯一键）。
 *
 * Telegram 不提供“是否由 inline 按钮唤起”的来源字段，因此普通按钮必须预填
 * 最小 `gag:` 标记；只靠空查询会与用户手动输入 `@机器人` 无法区分。
 */
export async function handleGagInlineQuery(ctx: Context): Promise<boolean> {
  const inlineQuery: InlineQuery | undefined = ctx.inlineQuery;
  if (inlineQuery === undefined) return false;
  const hasScopedPrefix: boolean =
    inlineQuery.query.startsWith(GAG_INLINE_QUERY_PREFIX);
  if (!hasScopedPrefix) return false;
  const scopedQuery: ParsedGagInlineQuery | undefined =
    parseGagInlineQuery(inlineQuery.query);
  const results: InlineQueryResultArticle[] = [];
  const now: number = Date.now();
  // 解析不出来的伪造前缀照样由 gag 认领，只是回一份空结果——绝不能退回运势。
  if (scopedQuery !== undefined) {
    for (const sessions of gagSessionsByChat.values()) {
      for (const session of sessions) {
        const matchesQuery: boolean = session.targetId < 0
          ? session.targetId === scopedQuery.targetChannelId &&
            session.inlineToken === scopedQuery.token
          : scopedQuery.targetChannelId === undefined &&
            session.targetId === inlineQuery.from.id;
        if (session.phase !== "active" || !matchesQuery) continue;
        if (session.expiresAt <= now) {
          expireGag(session);
          continue;
        }
        results.push(buildGagInlineResult(session, scopedQuery.text));
      }
    }
  }
  try {
    await ctx.answerInlineQuery(
      results,
      {
        cache_time: 0,
        is_personal: true,
      },
      currentUpdateAbortSignal() as unknown as
        Parameters<Context["answerInlineQuery"]>[2]
    );
  } catch (error: unknown) {
    throwIfUpdateAborted();
    logApiError("answer gag inline query", error);
  }
  return true;
}
