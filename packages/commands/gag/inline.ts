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
import { recordInlineResultSources } from "../../infra/inlineResultSources";
import { getGagThumbnailUrl } from "../../infra/storage/stateStore";
import {
  deleteMessageWithOutcome,
  logApiError,
} from "../../infra/telegram";
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../../infra/updateContext";
import { forumTopicThreadId } from "../../libs/forumTopic";
import { sanitizeInline, truncateInline } from "../../libs/text";
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
 *
 * `targetThreadId` 就是这条新入口要落进的话题：按消息数滚动换新时传当前话题
 * （原地换一条更靠下的），被管教的人换话题说话时传新话题（搬家）。两者是同一
 * 套「发新的 → 切槽位 → 删旧的」，因此不另写一条发送/删除路径。
 * `speakNoticeThreadId` 只在切槽位那一步更新，发送失败时仍指向旧话题，下一条
 * 消息还会再判一次要不要搬家。
 */
async function replaceGagSpeakNotice(
  session: GagSession,
  targetThreadId: number | undefined
): Promise<void> {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "active"
  ) return;
  const recordPending = (noticeMessageId: number): void => {
    session.pendingSpeakNoticeMessageId = noticeMessageId;
  };
  const noticeMessageId: number | undefined = await sendGagSpeakNotice({
    session,
    messageThreadId: targetThreadId,
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
  session.speakNoticeThreadId = targetThreadId;
  session.pendingSpeakNoticeMessageId = 0;
  session.retiredSpeakNoticeMessageId =
    previousNoticeMessageId === noticeMessageId
      ? 0
      : previousNoticeMessageId;
  session.messagesSinceSpeakNotice = 0;
  if (session.retiredSpeakNoticeMessageId === 0) return;
  await retryRetiredGagSpeakNotice(session);
}

/**
 * 同一会话只允许一条换新任务；timer/teardown 可通过字段等待并接管所有 id。
 *
 * 已有任务在途时直接复用它，不排队第二条：那条在途任务可能发往旧话题，于是
 * `speakNoticeThreadId` 仍与来消息的话题对不上，被管教的人下一条消息会再触发
 * 一次搬家。这条自愈路径成立的前提就是「他还在那个话题里说话」——不说话也就
 * 不需要按钮跟过去。
 */
async function refreshGagSpeakNotice(
  session: GagSession,
  targetThreadId: number | undefined
): Promise<void> {
  const existing: Promise<void> | null = session.speakNoticeRefreshTask;
  if (existing !== null) return existing;
  const task: Promise<void> = replaceGagSpeakNotice(session, targetThreadId);
  session.speakNoticeRefreshTask = task;
  try {
    await task;
  } finally {
    if (session.speakNoticeRefreshTask === task) {
      session.speakNoticeRefreshTask = null;
    }
  }
}

/**
 * 被管教的人在别的话题说话：把发言入口搬到那个话题，并删掉原话题里的旧入口。
 *
 * 与滚动换新共用 replaceGagSpeakNotice，因此 retired 槽位、单条在途任务与
 * ending 的接管语义全部沿用，不新增状态。搬家前先把上一次换新遗留的 retired
 * 清掉，理由同 refreshDueGagSpeakNotices：单槽位放不下第二条。
 */
async function moveGagSpeakNotice(
  session: GagSession,
  targetThreadId: number | undefined
): Promise<void> {
  if (
    findGagSession(session.chatId, session.targetId) !== session ||
    session.phase !== "active" ||
    session.expiresAt <= Date.now() ||
    session.speakNoticeThreadId === targetThreadId
  ) return;
  if (
    session.retiredSpeakNoticeMessageId !== 0 &&
    !await retryRetiredGagSpeakNotice(session)
  ) return;
  await refreshGagSpeakNotice(session, targetThreadId);
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
    // 滚动换新只是把入口挪到更靠下的位置，话题不变。
    await refreshGagSpeakNotice(session, session.speakNoticeThreadId);
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
  // 只有「说话的人正被管教」才付话题解析这两次属性读取；本 handler 排在所有
  // 命令之前，普通群消息不该为一个只对被管教者生效的判定买单。
  if (session !== undefined) {
    const threadId: number | undefined = forumTopicThreadId(message);
    if (threadId !== session.speakNoticeThreadId) {
      // 他换话题说话了：把发言入口搬过去。与滚动换新同一条理由绝不 await——
      // 这条 handler 卡住的是整个进程的所有群（见下面那段长注释）。
      trackGagBackgroundTask(
        moveGagSpeakNotice(session, threadId),
        "Unexpected error while moving a gag speak notice to another topic:"
      );
    }
  }
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
  // 发言正文由 renderGagSpeech 变形生成且不可逆，落群消息里没有这个人真正打的
  // 字；广告检测只能按结果正文取回这里登记的源文本（见
  // infra/inlineResultSources.ts）。归一方式与 renderGagSpeech 内部一致，登记的
  // 因此正是被变形的那段文本。
  recordInlineResultSources(
    inlineQuery.from.id,
    sanitizeInline(scopedQuery?.text ?? ""),
    results
  );
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
