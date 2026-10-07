import type {
  InlineQuery,
  InlineQueryResultArticle,
  Message,
  MessageEntity,
} from "grammy/types";
import { InlineQueryResultBuilder } from "grammy";
import { telegramSignal } from "../../libs/telegramSignal";
import type { Context } from "grammy";
import { gagSessionsByChat } from "../../cache/main/gag";
import {
  GAG_INLINE_LABEL_MAX_CHARS,
  GAG_INLINE_QUERY_PREFIX,
} from "../../consts/gag";
import { recordInlineResultSources } from "../../infra/inlineResultSources";
import { getAssetConfig } from "../../config/assets";
import {
  deleteMessageWithOutcome,
  logApiError,
} from "../../infra/telegram";
import { isTelegramRequestRejected } from "../../infra/telegram/errors";
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
  refreshGagSpeakNoticeOnSpeech,
  refreshDueGagSpeakNotices,
} from "./refresh";
import { collectDueGagSpeakNotices } from "./counter";
import {
  expireGag,
  finishGag,
} from "./runtime";
import {
  createGagInlineMarkerUrl,
  isGagInlineMarkerUrl,
} from "./identity";

/** 只把纯文本或带 caption 的媒体视作 gag 应删除的文字消息。 */
function hasGagDeletableText(message: Message): boolean {
  return typeof message.text === "string" ||
    typeof message.caption === "string";
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
 *
 * 认领判定全部同步完成，只有真要删消息或结束过期会话时才返回 Promise：本群没有会话、
 * 这条也不是本 bot 发出的旧 gag inline 结果时，判定只有一次 Map 查询与一次 via_bot/entity
 * 检查；本群有会话时，不认领的消息（非目标发言人等）同样同步返回 false。本 handler 挂在
 * 每条群消息之前（见 app/registerHandlers.ts）。
 */
export function handleGagMessageIngress(
  message: Message,
  botId: number
): boolean | Promise<boolean> {
  const sessions: GagSession[] | undefined =
    gagSessionsByChat.get(message.chat.id);
  if (sessions === undefined) {
    // 本群没有会话时，带标记的消息是跨群或已过期的 gag inline 结果，删除并认领。
    return hasGagInlineMarker(message, botId) ? deleteClaimedGagMessage(message) : false;
  }
  return claimGagMessage(message, botId, sessions);
}

/** 删除一条已认领的消息；删除结局不影响认领。 */
async function deleteClaimedGagMessage(message: Message): Promise<boolean> {
  await deleteMessageWithOutcome(message.chat.id, message.message_id);
  return true;
}

/** 结束到期会话；这条消息是带文字的 gag 入口候选时一并删除并认领。 */
async function finishExpiredGagOnMessage(
  session: GagSession,
  message: Message,
  deleteCandidate: boolean
): Promise<boolean> {
  await finishGag(session, "timeout");
  return deleteCandidate ? deleteClaimedGagMessage(message) : false;
}

/** 本群有会话时的认领判定（见 handleGagMessageIngress）。 */
function claimGagMessage(
  message: Message,
  botId: number,
  sessions: GagSession[]
): boolean | Promise<boolean> {
  const senderId: number | undefined =
    message.sender_chat?.id ?? message.from?.id;
  const session: GagSession | undefined = findActiveGagSenderSession(
    sessions,
    senderId
  );
  const now: number = Date.now();
  // 只有说话的人正被管教时才解析话题。
  if (session !== undefined) {
    const threadId: number | undefined = forumTopicThreadId(message);
    // 发言补发与跨话题移动均同步认领后台任务，不等待维护性的 Telegram 往返。
    refreshGagSpeakNoticeOnSpeech(session, threadId, now);
  }
  const isGagInlineMessage: boolean = session !== undefined &&
    isCurrentGagInlineMessage(message, botId, session);
  const hasDeletableText: boolean = hasGagDeletableText(message);
  const isDeletedGagTargetMessage: boolean =
    session !== undefined &&
    session.expiresAt > now &&
    !isGagInlineMessage &&
    hasDeletableText;
  if (!isDeletedGagTargetMessage) {
    // 会被 gag 删除的目标消息不计入任何入口的消息窗口（见 ./counter.ts）；
    // 通过按钮的发言和保留的无文字媒体仍计入。
    const due: GagSession[] | null = collectDueGagSpeakNotices(
      sessions,
      now
    );
    // 入口换新是维护动作，不在这条 ingress 里 await：交给统一的 gag 后台任务集合，
    // 停机由 drainGagRuntime 有界排空。换新任务自己重新核对会话仍是当前 active
    // 会话，并由 speakNoticeRefreshTask 保证同一会话只有一条在途。
    if (due !== null) refreshDueGagSpeakNotices(due);
  }
  const isCandidate: boolean = hasGagInlineMarker(message, botId) || isGagInlineCandidate(
    message,
    botId,
    sessions
  );
  if (session === undefined) {
    if (!isCandidate || !hasDeletableText) return false;
    return deleteClaimedGagMessage(message);
  }
  if (session.expiresAt <= Date.now()) {
    return finishExpiredGagOnMessage(session, message, isCandidate && hasDeletableText);
  }
  if (isGagInlineMessage && senderId === session.targetId) return false;
  if (!hasDeletableText) return false;
  return deleteClaimedGagMessage(message);
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
      thumbnail_url: getAssetConfig().gagThumbnailUrl,
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
 * InlineQuery 关于所在聊天只提供 chat_type，没有当前具体 chat.id 或发送前拦截钩子，
 * 查询文本里的 token/摘要/群 ID 只能声称来源。正常按钮用
 * switch_inline_query_current_chat 留在会话群；放行发生在消息入口：主页 marker
 * 绑定目标、fragment 绑定会话群，再与 Telegram 实际给出的 from.id/sender_chat.id、
 * message.chat.id 核验。频道候选使用不含群标题的通用标题。
 *
 * 不做分页：结果数受 GAG_SESSION_MAX（跨全部群的全局上限，见 gag/runtime.ts 的
 * reserveGagSession）约束；频道可在多个群有同一目标，具体群由结果的隐藏标记绑定。
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
  // 带 gag 前缀但解析不出来的查询照样由 gag 认领，回空结果，不退回运势。
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
      telegramSignal(currentUpdateAbortSignal())
    );
  } catch (error: unknown) {
    throwIfUpdateAborted();
    logApiError("answer gag inline query", error);
    if (isTelegramRequestRejected(error)) return true;
  }
  // 登记结果正文对应的源文本（见 infra/inlineResultSources.ts），广告检测按结果
  // 正文取回。归一方式与 renderGagSpeech 内部一致（sanitizeInline）。登记在会话
  // 目标 id 名下，落群后的发送者（本人 from.id 或频道 sender_chat.id）即该 id。
  if (scopedQuery !== undefined) {
    recordInlineResultSources(
      scopedQuery.targetId,
      sanitizeInline(scopedQuery.text),
      results
    );
  }
  return true;
}
