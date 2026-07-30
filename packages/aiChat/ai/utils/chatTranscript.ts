import type { BufferedMessage, BufferedReplyReference, ReplyChainLink } from "../../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../../types/aiChat/speaker";
import { FALLBACK_SPEAKER_NAME } from "../../../consts/auto";
import { COMPACT_BATCH_SIZE, REPLY_CHAIN_NODE_MAX_CHARS } from "../../../consts/aiChat/memory";
import {
  FORWARD_TAG_HINT,
  forwardTagTemplate,
  REPLY_CHAIN_SNAPSHOT_TAG,
  REPLY_TAG_HINT,
  replyChainTemplate,
  replyTagTemplate,
  TRANSCRIPT_LINE_FORMAT_HINT,
} from "../../../consts/aiChat/prompts/transcript";
import { truncateInline } from "../../../libs/text";

/** 发言人的显示名：first/last 拼接，都没有则给个占位。 */
export function displaySpeakerName(speaker: AiSpeakerSnapshot): string {
  return [speaker.firstName, speaker.lastName].filter((part: string): boolean => !!part).join(" ").trim() || FALLBACK_SPEAKER_NAME;
}

export function displayBufferedMessageName(message: BufferedMessage): string {
  return displaySpeakerName(message);
}

/** 转发来源标注，明确正文并非发送者本人所写；模板与说明文案共用（见
 * consts/aiChat/prompts/transcript.ts）。 */
function formatForwardTag(forwardedFrom: string | undefined): string {
  return forwardedFrom ? forwardTagTemplate(forwardedFrom) : "";
}

/** 回复关系以内嵌元数据呈现，模型无需靠相邻消息猜测被回复对象。 */
export function formatReplyReference(reference: BufferedReplyReference): string {
  const usernameTag: string = reference.username ? ` [username:@${reference.username.replace(/^@+/, "")}]` : "";
  const quote: string = reference.quote ? `；精确引用片段：「${reference.quote}」` : "";
  return replyTagTemplate({
    target: `[message_id:${reference.messageId}] [id:${reference.id}]${usernameTag} ${displaySpeakerName(reference)}`,
    text: reference.text,
    forwardTag: formatForwardTag(reference.forwardedFrom),
    quote,
  });
}

/**
 * 多层回复链标注：单跳回复标注只覆盖第一跳，链 ≥2 跳时在回复任务区块补
 * 全路径（见 workers/aiChat/promptContext.ts）。各跳身份与转发来源标记和
 * 转录行一致，正文按 REPLY_CHAIN_NODE_MAX_CHARS 截断。已滑出热区、仅靠
 * 上一跳回复快照保留的链尾显式标记；不足 2 跳时返回空串。
 */
export function formatReplyChain(triggerMessageId: number, chain: ReplyChainLink[]): string {
  if (chain.length < 2) return "";
  const links: string[] = chain.map((link: ReplyChainLink): string => {
    const usernameTag: string = link.username ? ` [username:@${link.username.replace(/^@+/, "")}]` : "";
    const snapshotTag: string = link.snapshotOnly ? ` ${REPLY_CHAIN_SNAPSHOT_TAG}` : "";
    return `[message_id:${link.messageId}] [id:${link.id}]${usernameTag} ${displaySpeakerName(link)}${formatForwardTag(link.forwardedFrom)}${snapshotTag}：「${truncateInline(link.text, REPLY_CHAIN_NODE_MAX_CHARS)}」`;
  });
  return replyChainTemplate(triggerMessageId, links);
}

/**
 * 把一条缓存消息格式化成喂给模型的一行：先拼记录时已格式化好的发送时间，
 * 再标出 id 避免重名混淆身份；有公开 username 时额外给出映射，让模型能把
 * 消息正文里的 @username 认回具体发言人。旧缓存没有 username 时保持原格式。
 */
export function formatBufferedMessageLine(message: BufferedMessage): string {
  const messageIdTag: string = ` [message_id:${message.messageId}]`;
  const usernameTag: string = message.username ? ` [username:@${message.username.replace(/^@+/, "")}]` : "";
  const replyTag: string = message.replyTo ? formatReplyReference(message.replyTo) : "";
  return `[${message.at}]${messageIdTag} [id:${message.id}]${usernameTag} ${displayBufferedMessageName(message)}${formatForwardTag(message.forwardedFrom)}${replyTag}：${message.text}`;
}

/**
 * 把逐字缓存按判断优先级分层：最新 COMPACT_BATCH_SIZE 条始终单列为最热
 * 记忆；更早、但仍未滑出逐字缓存的上一块列为次要背景。这样模型不会把
 * 压缩摘要、上一块逐字镜像和正在发生的对话等权看待。
 */
export function buildTieredVerbatimTranscript(messages: BufferedMessage[]): string {
  const hotStart: number = Math.max(0, messages.length - COMPACT_BATCH_SIZE);
  const earlier: BufferedMessage[] = messages.slice(0, hotStart);
  const hottest: BufferedMessage[] = messages.slice(hotStart);
  const formatInstruction: string =
    `每行格式为${TRANSCRIPT_LINE_FORMAT_HINT}，其中 message_id/username 标记在旧记录没有对应信息时省略。` +
    `若名字后出现「${REPLY_TAG_HINT}」则表示这条消息明确回复的对象和原文，精确引用片段是用户选中的部分。` +
    `若出现「${FORWARD_TAG_HINT}」则表示这条消息（或被回复的原消息）是从别处转发的，正文出自转发来源而非发送者本人；来源身份同样以 [id:]/[username:@] 标记区分，来源账号隐藏时只有显示名。` +
    "行首方括号里是发送时间（东京时间 UTC+9）；同名的人以 id 区分，正文里的 @用户名用 username 标记映射回具体的人。";
  const earlierBlock: string = earlier.length > 0
    ? "【较早逐字记录（次要背景）】这些记录仍是原文，但判断当前话题和应答对象时应让位于下方最热记忆：\n" +
      earlier.map(formatBufferedMessageLine).join("\n") +
      "\n\n"
    : "";
  const hotBlock: string =
    `【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】这是滑动缓存里最新、最应优先关注的逐字消息。` +
    "判断当前话题、人物指代、@对象、情绪和该回应谁时，必须优先依据本段；最后一条是最新消息：\n" +
    hottest.map(formatBufferedMessageLine).join("\n");
  return formatInstruction + "\n\n" + earlierBlock + hotBlock;
}

/** 已滑出逐字区的压缩摘要：只作为长期背景纳入理解，不参与判断当前状态
 * （两层仲裁见 consts/aiChat/prompts/memory.ts 的
 * CHAT_MEMORY_PRIORITY_INSTRUCTION）。 */
export function buildColdMemoryBlock(summaries: string[]): string {
  if (summaries.length === 0) return "";
  return (
    "【冷记忆（长期背景）】下列内容是更早对话的压缩摘要（按时间从旧到新），只用于理解长期话题、称呼、人物关系和前因后果，不用于判断当前状态；" +
    "它与较新的逐字记录不一致时，只说明情况后来变了，当前状态以逐字记录为准：\n" +
    summaries.map((summary: string, index: number): string => `${index + 1}. ${summary}`).join("\n")
  );
}
