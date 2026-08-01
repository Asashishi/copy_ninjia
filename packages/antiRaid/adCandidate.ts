/** 广告检测主线程入口：把一条 Telegram 群消息收敛为 Worker 所需的最小候选载荷。 */

import type { Chat, Message, MessageEntity } from "@grammyjs/types";
import { activeVerificationSnapshots } from "../cache/main/antiRaid/verificationMirror";
import { adDetectConfigReadiness } from "../config/readiness";
import {
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../consts/antiRaid/adDetect";
import { isUserBlocked } from "../infra/blocklist/membership";
import { AD_DETECT_DEEPSEEK_API_KEY } from "../infra/config";
import { isBotOwnMessage } from "../infra/selfSentTracker";
import { getChatState } from "../infra/storage/stateStore";
import { sanitizeInline, truncateInline } from "../libs/text";
import { verificationKey } from "../libs/verificationKey";
import type {
  AdCandidateMessage,
  AdSampleContext,
} from "../types/antiRaid";
import { formatUserLabel } from "../users/userLabel";
import { visibleSenderChat } from "../users/visibleSender";
import { canBypassAdDetection } from "./memberFacts";

/**
 * 摘出正文不可见的 text_link URL；与正文分开限额，避免超长填充文本把落地页
 * 挤出 Worker 的正文截断范围。
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
 * 摘出引用段与被回复原文，让“编辑旧消息后再顶上来”的广告仍进入判定；关联频道
 * 自动转发不连坐评论者，因此显式忽略其回复上下文。
 */
function buildSampleContext(message: Message): AdSampleContext | undefined {
  const replied: Message | undefined = message.reply_to_message;
  if (replied?.is_automatic_forward === true) return undefined;
  const rawQuote: string | undefined = message.quote?.text;
  const rawReplyTo: string | undefined = replied?.text ?? replied?.caption;
  if (
    (rawQuote === undefined || rawQuote.length === 0) &&
    (rawReplyTo === undefined || rawReplyTo.length === 0)
  ) {
    return undefined;
  }
  const quote: string = truncateInline(
    sanitizeInline(rawQuote ?? ""),
    AD_SAMPLE_CONTEXT_MAX_CHARS
  );
  const replyTo: string = truncateInline(
    sanitizeInline(rawReplyTo ?? ""),
    AD_SAMPLE_CONTEXT_MAX_CHARS
  );
  if (quote.length === 0 && replyTo.length === 0) return undefined;
  if (quote.length === 0) return { replyTo };
  if (replyTo.length === 0) return { quote };
  return { quote, replyTo };
}

/**
 * 收敛一条待判定消息。配置未就绪、功能未开启、受保护身份和机器人自己的消息
 * 均返回 undefined；频道黑名单落地空档仍投递，以便 Worker 删除漏网消息。
 */
export function buildAdCandidate(
  message: Message,
  botId: number
): AdCandidateMessage | undefined {
  const chatId: number | undefined = message.chat?.id;
  if (chatId === undefined || message.chat.type === "private") return undefined;
  if (AD_DETECT_DEEPSEEK_API_KEY === undefined) return undefined;
  if (!adDetectConfigReadiness().ok) return undefined;
  if (getChatState(chatId).isAdDetectEnabled !== true) return undefined;
  if (message.is_automatic_forward === true || isBotOwnMessage(message)) return undefined;

  const senderChat: Chat | undefined = visibleSenderChat(message);
  const senderId: number | undefined = senderChat?.id ?? message.from?.id;
  if (senderId === undefined || senderId === botId || senderChat?.id === chatId) return undefined;
  if (canBypassAdDetection(senderId)) return undefined;
  const blocked: boolean = isUserBlocked(senderId);
  if (blocked && senderChat === undefined) return undefined;

  const text: string = sanitizeInline(message.text ?? message.caption ?? "");
  const linkUrls: string[] | undefined = collectHiddenLinkUrls(
    text,
    message.entities ?? message.caption_entities
  );
  const sampleContext: AdSampleContext | undefined = buildSampleContext(message);
  if (text.length === 0 && linkUrls === undefined && sampleContext === undefined) return undefined;

  const label: string = senderChat === undefined
    ? formatUserLabel({
      id: senderId,
      username: message.from?.username,
      first_name: message.from?.first_name,
    })
    : formatUserLabel({
      id: senderId,
      username: "username" in senderChat ? senderChat.username : undefined,
      title: "title" in senderChat ? senderChat.title : undefined,
      isChannel: true,
    });
  const candidate: AdCandidateMessage = {
    type: "adCandidate",
    chatId,
    senderId,
    messageId: message.message_id,
    text,
    label,
    isChannel: senderChat !== undefined,
    blocked,
    justJoined: activeVerificationSnapshots.has(verificationKey(chatId, senderId)),
  };
  if (linkUrls !== undefined) candidate.linkUrls = linkUrls;
  if (sampleContext !== undefined) candidate.sampleContext = sampleContext;
  return candidate;
}
