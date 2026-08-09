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
  GAG_INLINE_PAGE_SIZE,
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
  expireGag,
  finishGag,
} from "./runtime";

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
  const prefix: string = gagSpeechPrefix(session.tool);
  const commonMatches: boolean = message.via_bot?.id === botId &&
    typeof message.text === "string" &&
    message.text.startsWith(prefix);
  if (!commonMatches || session.targetId > 0) return commonMatches;
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
  // 这是 gag 生效群的每消息热路径；全局容量只有 5，直接扫本群小数组，避免
  // Array.find 为每条消息创建一次性回调。
  let session: GagSession | undefined;
  if (senderId !== undefined) {
    for (const candidate of sessions) {
      if (
        candidate.targetId === senderId &&
        candidate.phase === "active"
      ) {
        session = candidate;
        break;
      }
    }
  }
  const isCandidate: boolean = hasMarker || isGagInlineCandidate(
    message,
    botId,
    sessions
  );
  if (session === undefined) {
    if (!isCandidate) return false;
    await deleteMessageWithOutcome(message.chat.id, message.message_id);
    return true;
  }
  const isGagInlineMessage: boolean = isCurrentGagInlineMessage(
    message,
    botId,
    session
  );
  if (session.expiresAt <= Date.now()) {
    await finishGag(session, "timeout");
    if (isCandidate) {
      await deleteMessageWithOutcome(message.chat.id, message.message_id);
      return true;
    }
    return false;
  }
  if (isGagInlineMessage && senderId === session.targetId) return false;
  await deleteMessageWithOutcome(message.chat.id, message.message_id);
  return true;
}

/** 只接受规范十进制分页 offset；客户端或恶意输入异常时从第一页开始。 */
function parseInlineOffset(raw: string): number {
  if (!/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const offset: number = Number(raw);
  return Number.isSafeInteger(offset) ? offset : 0;
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
 * 3. `gag:<负数频道 id> <正文>` 只定位频道会话，发送落群后再核对 sender_chat；
 * 4. 任何带 `gag:` 的查询都由本函数终止分发；非法、过期或身份不匹配时回空，
 *    绝不能回退运势或同时生成两类结果。
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
  const offset: number = parseInlineOffset(inlineQuery.offset);
  const results: InlineQueryResultArticle[] = [];
  const now: number = Date.now();
  let matchingIndex: number = 0;
  for (const sessions of gagSessionsByChat.values()) {
    for (const session of sessions) {
      const matchesQuery: boolean = session.targetId < 0
        ? session.targetId === scopedQuery?.targetChannelId
        : scopedQuery !== undefined &&
          scopedQuery.targetChannelId === undefined &&
          session.targetId === inlineQuery.from.id;
      if (session.phase !== "active" || !matchesQuery) continue;
      if (session.expiresAt <= now) {
        expireGag(session);
        continue;
      }
      if (
        matchingIndex >= offset &&
        results.length < GAG_INLINE_PAGE_SIZE
      ) {
        results.push(buildGagInlineResult(
          session,
          scopedQuery?.text ?? ""
        ));
      }
      matchingIndex++;
    }
  }
  const nextOffset: string = offset + results.length < matchingIndex
    ? String(offset + results.length)
    : "";
  try {
    await ctx.answerInlineQuery(
      results,
      {
        cache_time: 0,
        is_personal: true,
        next_offset: nextOffset,
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
