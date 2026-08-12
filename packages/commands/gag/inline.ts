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
import {
  createGagInlineMarkerUrl,
  isGagInlineMarkerUrl,
} from "./identity";

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

/** 当前 bot 消息是否带有用户或频道 gag 隐藏主页标记。 */
function hasGagInlineMarker(message: Message, botId: number): boolean {
  if (message.via_bot?.id !== botId) return false;
  return message.entities?.some((entity: MessageEntity): boolean =>
    entity.type === "text_link" &&
    entity.offset === 0 &&
    isGagInlineMarkerUrl(entity.url)
  ) === true;
}

/** 当前 bot inline 文本是否匹配用具，且隐藏主页链接匹配当前目标与所在群。 */
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
  const markerUrl: string = createGagInlineMarkerUrl(session);
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
 * 命令前的消息入口：活动目标的任何消息都被认领。频道 inline 结果必须由主页
 * 标记与 sender_chat.id 同时绑定发言频道，并由 fragment 与 message.chat.id
 * 同时绑定超级群；用户分支对应核对主页标记、群 ID 与 from.id。
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
  const resultTitle: string = session.targetId < 0
    ? "以频道身份发言"
    : `在 ${truncateInline(
      session.chatLabel,
      GAG_INLINE_LABEL_MAX_CHARS
    )} 发言`;
  const toolLabel: string = truncateInline(
    session.tool,
    GAG_INLINE_LABEL_MAX_CHARS
  );
  const messageText: string = renderGagSpeech({
    text: query,
    tool: session.tool,
  });
  const prefixLength: number = gagSpeechPrefix(session.tool).length;
  const entities: MessageEntity[] = [{
    type: "text_link",
    offset: 0,
    length: prefixLength,
    url: createGagInlineMarkerUrl(session),
  }];
  return InlineQueryResultBuilder.article(
    `gag-${session.chatId}-${session.targetId}`,
    resultTitle,
    {
      description: `透过${toolLabel}`,
      thumbnail_url: getGagThumbnailUrl(),
    }
  ).text(messageText, {
    entities,
    link_preview_options: { is_disabled: true },
  });
}

/**
 * gag / 运势 inline 协议（不得合并入口）：
 * 1. 无 `gag:` 前缀时必须返回 false，即使查询者正被 gag，也只允许下游运势应答；
 * 2. 用户与频道 scope 的唯一语法均为 `gag:<目标 ID> <正文>`；首个空格前不得
 *    加摘要、随机 token、群 ID 或其它元数据；
 * 3. 用户查询还要按目标 ID 与 `from.id` 匹配；频道查询只按负数目标 ID 定位；
 * 4. 频道结果发送落群后同时核对
 *    sender_chat.id、message.chat.id 与隐藏标记；
 * 5. 任何带 `gag:` 的查询都由本函数终止分发；非法、过期或用户身份不匹配时回空，
 *    绝不能回退运势或同时生成两类结果。
 *
 * InlineQuery 关于所在聊天只提供 chat_type，没有当前具体 chat.id 或发送前拦截钩子；
 * 追加 token/摘要/群 ID 只能声称来源，不能证明输入框在哪个群，因此禁止重新引入。
 * 正常按钮用 switch_inline_query_current_chat 留在会话群；真正放行发生在消息入口：
 * 主页 marker 绑定目标、fragment 绑定会话群，再与 Telegram 实际给出的
 * from.id/sender_chat.id、message.chat.id 核验。频道候选使用不含群标题的通用标题。
 *
 * 不做分页：GAG_SESSION_MAX 是**跨全部群**的全局上限（见 gag/runtime.ts 的
 * reserveGagSession），远小于单次 answerInlineQuery 的 50 条上限，而每条查询最多
 * 匹配五条会话；频道可在多个群有同一目标，具体群由结果的隐藏标记绑定。
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
          ? session.targetId === scopedQuery.targetId
          : session.targetId === scopedQuery.targetId &&
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
