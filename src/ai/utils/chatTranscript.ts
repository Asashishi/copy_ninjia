import type { BufferedMessage } from "../../types";
import { FALLBACK_SPEAKER_NAME } from "../../consts/auto";
import { COMPACT_BATCH_SIZE } from "../../consts/aiChat";

/** 发言人的显示名：first/last 拼接，都没有则给个占位。 */
export function displayBufferedMessageName(message: BufferedMessage): string {
  return [message.firstName, message.lastName].filter((part: string) => !!part).join(" ").trim() || FALLBACK_SPEAKER_NAME;
}

/**
 * 把一条缓存消息格式化成喂给模型的一行：先拼记录时已格式化好的发送时间，
 * 再标出 id 避免重名混淆身份；有公开 username 时额外给出映射，让模型能把
 * 消息正文里的 @username 认回具体发言人。旧缓存没有 username 时保持原格式。
 */
export function formatBufferedMessageLine(message: BufferedMessage): string {
  const usernameTag: string = message.username ? ` [username:@${message.username.replace(/^@+/, "")}]` : "";
  return `[${message.at}] [id:${message.id}]${usernameTag} ${displayBufferedMessageName(message)}：${message.text}`;
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
    "每行格式为「[年/月/日 时:分:秒] [id:用户ID] [username:@公开用户名] 名字：内容」，其中 username 标记仅在发言人有公开用户名时出现。" +
    "行首方括号里是发送时间（东京时间 UTC+9）；同名的人以 id 区分，正文里的 @用户名用 username 标记映射回具体的人。";
  const earlierBlock: string = earlier.length > 0
    ? "【较早逐字记录（次要背景）】这些记录仍是原文，可信度高于压缩摘要，但判断当前话题和应答对象时应让位于下方最热记忆：\n" +
      earlier.map(formatBufferedMessageLine).join("\n") +
      "\n\n"
    : "";
  const hotBlock: string =
    `【最热记忆（重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条）】这是滑动缓存里最新、最应优先关注的逐字消息。` +
    "判断当前话题、人物指代、@对象、情绪和该回应谁时，必须优先依据本段；最后一条是最新消息：\n" +
    hottest.map(formatBufferedMessageLine).join("\n");
  return formatInstruction + "\n\n" + earlierBlock + hotBlock;
}

/** 已滑出逐字区的压缩摘要：作为必须纳入理解的长期背景；与较新记录有差异
 * 时按时间理解为状态演变，当前状态再以较新逐字记录为准。 */
export function buildColdMemoryBlock(summaries: string[]): string {
  if (summaries.length === 0) return "";
  return (
    "【冷记忆（长期背景，必须参考）】下列内容是更早对话的压缩摘要（按时间从旧到新），用于理解长期话题、称呼、人物关系和前因后果。" +
    `摘要可能丢失细节，但不能直接忽略；它与较新的逐字记录出现差异时，先结合时间和语境判断这是否代表状态、观点或关系后来发生了变化。历史背景仍保留，当前状态则以较新的逐字记录为准，尤其优先参考最新 ${COMPACT_BATCH_SIZE} 条最热记忆：\n` +
    summaries.map((summary: string, index: number) => `${index + 1}. ${summary}`).join("\n") +
    "\n\n"
  );
}
