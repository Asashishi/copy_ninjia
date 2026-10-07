/** 广告检测主线程入口：把一条 Telegram 群消息收敛为 Worker 所需的最小候选载荷。 */

import type {
  Chat,
  Message,
  MessageEntity,
  MessageOrigin,
} from "grammy/types";
import { activeVerificationSnapshots } from "../cache/main/antiRaid/verificationMirror";
import { adDetectConfigReadiness } from "../config/readiness";
import {
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../consts/antiRaid/adDetect";
import { isUserBlocked } from "../infra/blocklist/membership";
import { isIdentityPolicyCached } from "../infra/identityStorage";
import { inlineResultSourceOf } from "../infra/inlineResultSources";
import { isBotOwnMessage } from "../infra/selfSentTracker";
import { sanitizeInline, truncateInline } from "../libs/text";
import { verificationKey } from "../libs/verificationKey";
import type {
  AdCandidateMessage,
  AdDetectionMessageContext,
  AdSampleContext,
} from "../types/antiRaid/adDetect";
import type { TelegramIdentityMetadata } from "../types/identityPolicy";
import { messageOriginIdentityId } from "../users/messageOrigin";
import { visibleSenderId } from "../users/visibleSender";
import { messageIdentityMetadata } from "../users/identityMetadata";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { canBypassAdDetection } from "./memberFacts";

/**
 * 摘出正文不可见的 text_link URL；与正文分开限额（AD_DETECT_MAX_LINK_URLS、
 * AD_DETECT_LINK_URL_MAX_CHARS）。
 */
function collectHiddenLinkUrls(
  text: string,
  entities: readonly MessageEntity[] | undefined
): string[] | undefined {
  if (entities === undefined) return undefined;
  let urls: string[] | undefined;
  for (const entity of entities) {
    if ((urls?.length ?? 0) >= AD_DETECT_MAX_LINK_URLS) break;
    if (entity.type !== "text_link") continue;
    const url: string = truncateInline(
      sanitizeInline(entity.url),
      AD_DETECT_LINK_URL_MAX_CHARS
    );
    if (url.length === 0 || text.includes(url) || urls?.includes(url) === true) continue;
    urls ??= [];
    urls.push(url);
  }
  return urls;
}

/**
 * 被回复消息的来源身份：优先取 forward_origin 或 external_reply.origin 解析出的身份，
 * 否则取被回复消息的可见发送者；隐藏来源或没有被回复消息时为 undefined。
 */
function replySourceIdentityId(message: Message): number | undefined {
  const replied: Message | undefined = message.reply_to_message;
  const origin: MessageOrigin | undefined =
    replied?.forward_origin ?? message.external_reply?.origin;
  if (origin !== undefined) return messageOriginIdentityId(origin);
  return replied === undefined ? undefined : visibleSenderId(replied);
}

/**
 * 引用来源的受保护身份三态：永久白名单成员或临时广告豁免返回 true；
 * 身份策略缓存已就绪（isIdentityPolicyCached）且不受保护返回 false；
 * 缓存冷缺失（update 前置预取失败）返回 undefined。
 */
function sourceWhitelistStatus(
  sourceId: number,
  now: number
): boolean | undefined {
  if (
    isWhitelisted(sourceId) ||
    canBypassAdDetection(sourceId, now)
  ) return true;
  return isIdentityPolicyCached(sourceId) ? false : undefined;
}

/**
 * 摘出非白名单来源的引用段与被回复原文；关联频道自动转发与白名单来源的回复上下文
 * 忽略（返回 undefined）。
 */
function buildSampleContext(
  message: Message,
  now: number
): AdSampleContext | undefined {
  const replied: Message | undefined = message.reply_to_message;
  if (replied?.is_automatic_forward === true) return undefined;
  const sourceId: number | undefined = replySourceIdentityId(message);
  if (
    sourceId !== undefined &&
    sourceWhitelistStatus(sourceId, now) !== false
  ) return undefined;
  const rawQuote: string | undefined = message.quote?.text;
  const rawReplyTo: string | undefined = replied?.text ?? replied?.caption;
  if (
    (rawQuote === undefined || rawQuote.length === 0) &&
    (rawReplyTo === undefined || rawReplyTo.length === 0)
  ) {
    return undefined;
  }
  // 截断后去掉末尾空白，交给 Worker 的是清洗完成的单行文本，
  // Worker 侧只再收一次长度（见 workers/antiRaid/adDetect/bundle.ts 的 boundSampleContext）。
  const quote: string = truncateInline(
    sanitizeInline(rawQuote ?? ""),
    AD_SAMPLE_CONTEXT_MAX_CHARS
  ).trimEnd();
  const replyTo: string = truncateInline(
    sanitizeInline(rawReplyTo ?? ""),
    AD_SAMPLE_CONTEXT_MAX_CHARS
  ).trimEnd();
  if (quote.length === 0 && replyTo.length === 0) return undefined;
  if (quote.length === 0) return { replyTo };
  if (replyTo.length === 0) return { quote };
  return { quote, replyTo };
}

/**
 * 广告累计与候选构建共同的前置判定，每条群消息只做一次；调用方已确认本群开着广告检测，
 * senderChat 为 visibleSenderChat(message)。判定广告检测配置就绪、不是自动转发或机器人
 * 自己的消息、有展示身份且不是机器人自己或本群的群身份。
 * @returns 通过时返回展示身份 id（频道马甲优先，否则 from.id），否则 undefined。
 */
export function adDetectionSenderId(
  message: Message,
  botId: number,
  senderChat: Chat | undefined
): number | undefined {
  if (message.chat.type === "private" || !adDetectConfigReadiness().ok) return undefined;
  if (message.is_automatic_forward === true || isBotOwnMessage(message)) return undefined;
  const senderId: number | undefined = senderChat?.id ?? message.from?.id;
  if (senderId === undefined || senderId === botId || senderChat?.id === message.chat.id) return undefined;
  return senderId;
}

/**
 * 收敛一条已通过 adDetectionSenderId 前置判定的待判定消息。受保护身份返回 undefined；
 * 频道黑名单落地空档仍投递，由 Worker 删除漏网消息。
 */
export function buildAdCandidate(
  {
    message,
    botId,
    now,
    senderId,
    senderChat,
  }: AdDetectionMessageContext
): AdCandidateMessage | undefined {
  const chatId: number = message.chat.id;
  if (canBypassAdDetection(senderId, now)) return undefined;
  const blocked: boolean = isUserBlocked(senderId);
  if (blocked && senderChat === undefined) return undefined;

  // 本 bot 自己的 inline 结果送检用户打进 inline 查询的源文本，不送检落群的渲染正文。
  // 源文本只在应答时登记（见 infra/inlineResultSources.ts），取不到就整条不判。
  const selfInlineResult: boolean = message.via_bot?.id === botId;
  let inlineSource: string | undefined;
  if (selfInlineResult) {
    inlineSource = inlineResultSourceOf(senderId, message.text ?? "");
    if (inlineSource === undefined) return undefined;
  }

  const isForwarded: boolean = message.forward_origin !== undefined;
  const forwardSourceId: number | undefined =
    messageOriginIdentityId(message.forward_origin);
  if (
    !blocked &&
    isForwarded &&
    forwardSourceId !== undefined &&
    sourceWhitelistStatus(forwardSourceId, now) !== false
  ) return undefined;

  const text: string = sanitizeInline(
    inlineSource ?? message.text ?? message.caption ?? ""
  );
  // 送检源文本时不补 text_link：实体属于本 bot 渲染的正文，与源文本对不上；
  // 用户打进查询的链接留在源文本里参与判定。
  const linkUrls: string[] | undefined = selfInlineResult
    ? undefined
    : collectHiddenLinkUrls(
      text,
      message.entities ?? message.caption_entities
    );
  const sampleContext: AdSampleContext | undefined = buildSampleContext(message, now);
  if (text.length === 0 && linkUrls === undefined && sampleContext === undefined) return undefined;

  const meta: Readonly<TelegramIdentityMetadata> =
    messageIdentityMetadata(message, senderChat);
  // 可缺席的字段无条件写在初始化处，保持对象 shape 一致，口径同 aiChat/workerBridge.ts
  // 的「字段一律发出，不用条件展开」与 auto/message/facts.ts。元数据与引用上下文平铺成
  // 原始值字段，载荷保持扁平（见 types/antiRaid/adDetect.ts 的 AdCandidateMessage）。
  return {
    type: "adCandidate",
    chatId,
    senderId,
    messageId: message.message_id,
    observedAt: now,
    text,
    firstName: meta.firstName,
    lastName: meta.lastName,
    username: meta.username,
    isChannel: senderChat !== undefined,
    isForwarded,
    blocked,
    // 同 updateIngress.ts：空表时跳过复合键构造。
    justJoined: activeVerificationSnapshots.size > 0 &&
      activeVerificationSnapshots.has(verificationKey(chatId, senderId)),
    linkUrls,
    sampleQuote: sampleContext?.quote,
    sampleReplyTo: sampleContext?.replyTo,
  };
}
