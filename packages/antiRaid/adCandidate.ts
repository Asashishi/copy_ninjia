/** 广告检测主线程入口：把一条 Telegram 群消息收敛为 Worker 所需的最小候选载荷。 */

import type {
  Chat,
  Message,
  MessageEntity,
  MessageOrigin,
} from "@grammyjs/types";
import { activeVerificationSnapshots } from "../cache/main/antiRaid/verificationMirror";
import { adDetectConfigReadiness } from "../config/readiness";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import {
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../consts/antiRaid/adDetect";
import { isUserBlocked } from "../infra/blocklist/membership";
import { isIdentityPolicyCached } from "../infra/identityStorage";
import { inlineResultSourceOf } from "../infra/inlineResultSources";
import { isBotOwnMessage } from "../infra/selfSentTracker";
import { getChatState } from "../infra/storage/stateStore";
import { sanitizeInline, truncateInline } from "../libs/text";
import { verificationKey } from "../libs/verificationKey";
import type {
  AdCandidateMessage,
  AdSampleContext,
} from "../types/antiRaid/adDetect";
import type { ChatState } from "../types/chatState";
import { formatUserLabel } from "../users/userLabel";
import { messageOriginIdentityId } from "../users/messageOrigin";
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
 * 摘出非白名单来源的引用段与被回复原文，让“编辑旧消息后再顶上来”的广告仍进入
 * 判定；关联频道自动转发与白名单来源不连坐评论者，因此显式忽略其回复上下文。
 */
function replySourceIdentityId(message: Message): number | undefined {
  const replied: Message | undefined = message.reply_to_message;
  const origin: MessageOrigin | undefined =
    replied?.forward_origin ?? message.external_reply?.origin;
  if (origin !== undefined) return messageOriginIdentityId(origin);
  return replied === undefined
    ? undefined
    : visibleSenderChat(replied)?.id ?? replied.from?.id;
}

/**
 * 引用来源的白名单三态。超级管理员和热白名单直接返回 true；两张策略缓存都热
 * 才能确证 false。冷缺失表示 update 前置预取失败，不能把未知身份送进永久封禁
 * 的升级路径。
 */
function sourceWhitelistStatus(sourceId: number): boolean | undefined {
  if (isWhitelisted(sourceId)) return true;
  return isIdentityPolicyCached(sourceId) ? false : undefined;
}

function buildSampleContext(message: Message): AdSampleContext | undefined {
  const replied: Message | undefined = message.reply_to_message;
  if (replied?.is_automatic_forward === true) return undefined;
  const sourceId: number | undefined = replySourceIdentityId(message);
  if (
    sourceId !== undefined &&
    sourceWhitelistStatus(sourceId) !== false
  ) return undefined;
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
 * @param chatState 同一同步消息入口已读取的当前群状态；缺省时本函数自行读取。
 */
export function buildAdCandidate(
  message: Message,
  botId: number,
  chatState?: Readonly<ChatState>
): AdCandidateMessage | undefined {
  const chatId: number | undefined = message.chat?.id;
  if (chatId === undefined || message.chat.type === "private") return undefined;
  if (!adDetectConfigReadiness().ok) return undefined;
  const currentState: Readonly<ChatState> = chatState ?? getChatState(chatId);
  if (currentState.isAdDetectEnabled !== true) return undefined;
  if (message.is_automatic_forward === true || isBotOwnMessage(message)) return undefined;

  const senderChat: Chat | undefined = visibleSenderChat(message);
  const senderId: number | undefined = senderChat?.id ?? message.from?.id;
  if (senderId === undefined || senderId === botId || senderChat?.id === chatId) return undefined;
  if (canBypassAdDetection(senderId)) return undefined;
  const blocked: boolean = isUserBlocked(senderId);
  if (blocked && senderChat === undefined) return undefined;

  // 本 bot 自己的 inline 结果送检的是**用户打进 inline 查询的源文本**，不是落群
  // 的那段正文：后者整段由本 bot 渲染——gag 按字形随机插点、替换字符，正落在提示
  // 词 B 条「联系方式或关键词被刻意变形……看到就几乎可以判 true」这个最强单项信号
  // 上；运势那边则是问候、抽签结果与防伪回执，用户写的只有所求事项一段。拿渲染
  // 结果送检等于按本 bot 自己的排版判人。源文本只在应答那一刻登记得到（见
  // infra/inlineResultSources.ts），取不到就整条不判——登记被容量挤掉、进程在发言
  // 之后重启，或客户端发出的是上一次按键那条结果，都不足以拿另一段文本去判一条
  // 真实消息，而本 bot 的渲染结果一个字都不该流进判定。
  const selfInlineResult: boolean = message.via_bot?.id === botId;
  let inlineSource: string | undefined;
  if (selfInlineResult) {
    inlineSource = inlineResultSourceOf(message.text ?? "");
    if (inlineSource === undefined) return undefined;
  }

  const isForwarded: boolean = message.forward_origin !== undefined;
  const forwardSourceId: number | undefined =
    messageOriginIdentityId(message.forward_origin);
  if (
    !blocked &&
    isForwarded &&
    forwardSourceId !== undefined &&
    sourceWhitelistStatus(forwardSourceId) !== false
  ) return undefined;

  const text: string = sanitizeInline(
    inlineSource ?? message.text ?? message.caption ?? ""
  );
  // 送检的是源文本时，实体属于本 bot 渲染出来的那段正文，与源文本对不上号，
  // 一律不补。本 bot 的 inline 结果里 text_link 也**全部**是自己拼上去的（结果按
  // 显式 entities 发出，用户打的字只是纯文本；Telegram 自动识别出来的裸链接是
  // `url` 实体，不是这里读的 `text_link`），补进去只会给每条运势结果凭空添一个
  // 「把人带离本群的落点」——那是运势的防伪回执链接。用户自己打进查询的链接留在
  // 源文本里，照常参与判定。
  const linkUrls: string[] | undefined = selfInlineResult
    ? undefined
    : collectHiddenLinkUrls(
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
  const meta: Readonly<{
    firstName: string;
    lastName: string;
    username: string;
  }> = senderChat === undefined
    ? {
      firstName: message.from?.first_name ?? "",
      lastName: message.from?.last_name ?? "",
      username: message.from?.username ?? "",
    }
    : {
      firstName: "title" in senderChat ? senderChat.title ?? "" : "",
      lastName: "",
      username: "username" in senderChat ? senderChat.username ?? "" : "",
    };
  // 两个可选字段无条件写在初始化处：事后 `if (x !== undefined) candidate.x = …`
  // 会让每条开启广告检测的群消息产出四种 hidden class，把 adDetect 队列的读点与
  // structured clone 边界一起多态化。口径同 aiChat/workerBridge.ts 的「字段一律
  // 发出，不用条件展开」与 auto/message/facts.ts。
  return {
    type: "adCandidate",
    chatId,
    senderId,
    messageId: message.message_id,
    text,
    label,
    meta,
    isChannel: senderChat !== undefined,
    isForwarded,
    blocked,
    // 同 updateIngress.ts：空表上不必先拼复合键，`has()` 本来也只会返回 false。
    justJoined: activeVerificationSnapshots.size > 0 &&
      activeVerificationSnapshots.has(verificationKey(chatId, senderId)),
    linkUrls,
    sampleContext,
  };
}
