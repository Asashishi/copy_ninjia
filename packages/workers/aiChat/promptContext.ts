import type { BoundedDeque } from "../../libs/boundedDeque";
import {
  buildColdMemoryBlock,
  buildTieredVerbatimTranscript,
  formatSpeakerIdentity,
} from "../../aiChat/ai/utils/chatTranscript";
import {
  MAX_SUMMARY_ROUNDS,
  VERBATIM_CONTEXT_MAX,
} from "../../consts/aiChat/memory";
import {
  directInvokerSentence,
  REPLY_CONTEXT_SECTION_NAMES,
  REPLY_CONTEXT_SECTION_TEXT,
} from "../../consts/aiChat/prompts/memory";
import {
  DIRECT_TRIGGER_INSTRUCTION,
  forwardedMediaNotice,
  mediaCommentInstruction,
  mediaMentionTriggerInstruction,
  mediaReplyTriggerInstruction,
  QUEUED_TRIGGER_FALLBACK_SENDER_NAME,
  queuedTriggerDescription,
  queuedTriggerInstruction,
  RANDOM_TRIGGER_INSTRUCTION,
  selfIdentityStatement,
} from "../../consts/aiChat/prompts/replyTask";
import { forwardPathTemplate } from "../../consts/aiChat/prompts/transcript";
import { TYPO_REQUIRED_INSTRUCTION } from "../../consts/aiChat/prompts/tools";
import { chatBuffers, chatSummaries } from "../../cache/workers/aiChat/memory";
import { lookupBufferedMessage } from "./bufferedMessageIndex";
import { resolvedTagFor } from "./mediaText";
import type { RenderedTranscript } from "../../aiChat/ai/utils/chatTranscript";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import type {
  MediaCommentContext,
  QueuedReplyTrigger,
  ReplyPromptSections,
} from "../../types/aiChat/replies";
import type { MediaKind } from "../../types/media";

/** 以占位描述"…"调用 mediaText.ts 的 resolvedTagFor，得到提示词里展示的标签样式。 */
function mediaTagHintFor(kind: MediaKind): string {
  return resolvedTagFor(kind, "…");
}

/** 用稳定 id 标出转发者，方向固定为「原始来源 → 当前群发送者」。 */
function forwardPathFor(origin: string | undefined, senderId: number, senderName: string): string {
  return origin ? forwardPathTemplate(origin, `[id:${senderId}] ${senderName}`) : "";
}

/** 排队补跑的触发快照描述：转发路径与回复标注按本轮转录的编号渲染。 */
function describeQueuedTrigger(queuedTrigger: QueuedReplyTrigger, rendered: RenderedTranscript): string {
  const senderName: string = queuedTrigger.senderName || QUEUED_TRIGGER_FALLBACK_SENDER_NAME;
  return queuedTriggerDescription({
    senderName,
    forwardPath: forwardPathFor(queuedTrigger.forwardedFrom, queuedTrigger.triggerSenderId, senderName),
    text: queuedTrigger.text,
    replyReference: queuedTrigger.replyTo ? rendered.replyReference(queuedTrigger.replyTo) : "",
  });
}

/**
 * 唤起者的完整身份快照。协议只传 id，first/last name 与 username 从逐字缓存回填，
 * 与转录行使用同一份快照。
 *
 * 先比对触发消息本身；触发消息已滑出逐字区时，从缓存尾部往回找 TA 最近的一条；
 * 整段缓存里都没有 TA 时返回 undefined，由调用方只报 id。
 */
function resolveInvoker(
  recent: BufferedMessage[],
  triggerMessage: BufferedMessage | undefined,
  invokerId: number
): AiSpeakerSnapshot | undefined {
  if (triggerMessage?.id === invokerId) return triggerMessage;
  for (let index: number = recent.length - 1; index >= 0; index -= 1) {
    const message: BufferedMessage = recent[index]!;
    if (message.id === invokerId) return message;
  }
  return undefined;
}

/** buildReplyPromptSections 的可选附加上下文，按需组合，见各字段说明。 */
export interface UserContentOptions {
  /** 本轮触发消息的 message_id（即工具挂回复引用的目标，见 replyRound.ts
   *  的 replyToMessageId）：用于从热区索引定位触发消息的身份，
   *  并在转录中保留触发消息的消息号。 */
  triggerMessageId: number;
  /** 明确 @/回复机器人的唤起者 id。仅直接触发传入；随机文字插话和随机媒体
   *  评价省略。用于在回复任务开头声明「正在跟你说话的是谁」，身份段按这个
   *  id 从逐字缓存里回填 first/last name 与 username，见 resolveInvoker。 */
  directInvokerId?: number;
  /** 是否是随机插话触发（见 replyPipeline.ts 的 generateAndSendReply 的
   *  isRandomTrigger）：没有人在叫机器人，是否挂 reply_to_trigger、是否称呼对方
   *  由模型自主判断，但回复指令要求留下回应（说话/贴纸/扣反应都算）。 */
  isRandomTrigger: boolean;
  /** 若本次是「解析完图片/贴纸/GIF 后评价它」触发（见 mediaIngest.ts 的
   *  recordChatMedia），发送人与描述——回复指令改为针对这份媒体发表评价，
   *  替代默认的「接住最新消息」。 */
  mediaComment?: MediaCommentContext;
  /** 若本次是排队补跑的直接触发（见 replyQueue.ts 的 drainReplyQueue），
   *  入队时的触发消息快照——回复指令改为点名回复那条具体消息（此刻它已不
   *  在转录尾部）；自己后来的发言已覆盖过它且没有新内容时直接结束。 */
  queuedTrigger?: QueuedReplyTrigger;
  /** 本轮是否走「出错」分支：由 replyRound.ts 的 startReplyRound 在请求
   *  模型之前按 consts/aiChat/tools.ts 的 AI_TEXT_TYPO_PROBABILITY 掷一次骰子决定。
   *  为 true 时在回复指令末尾拼上 TYPO_REQUIRED_INSTRUCTION，为 false 时不拼。
   *  同一个值也传给 createReplyToolset（ReplyToolContext.roundHasTypo）。 */
  roundHasTypo: boolean;
}

/**
 * 把某群的对话上下文拼装成三个职责固定的模型输入区块：只读参考记忆、只读
 * 当前会话和本轮回复任务。replyModel.ts 在转录与回复任务之间补上运行时状态区块，
 * 并按稳定 / 易变分组交给实现包映射成 user 内容里的 text Part。
 * @param chatId 群聊 ID。
 * @param selfInfo 机器人自己的账号身份（见 cache/workers/aiChat/identity.ts 的 botInfoState），用于转录里的自我认知。
 * @returns 拼好的三个区块与当前会话内的转录已定切点；缓存为空时返回 null。
 */
export function buildReplyPromptSections(
  chatId: number,
  selfInfo: AiBotInfo,
  {
    triggerMessageId,
    directInvokerId,
    isRandomTrigger,
    mediaComment,
    queuedTrigger,
    roundHasTypo,
  }: UserContentOptions
): ReplyPromptSections | null {
  const buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(VERBATIM_CONTEXT_MAX);
  // selfId 使机器人自己的行使用固定编号；triggerMessageId 保留触发消息的消息号。
  const rendered: RenderedTranscript = buildTieredVerbatimTranscript(recent, {
    selfId: selfInfo.id,
    triggerMessageId,
  });
  const triggerMessage: BufferedMessage | undefined = lookupBufferedMessage(chatId, triggerMessageId);
  const mediaForwardNotice: string = mediaComment
    ? forwardedMediaNotice(forwardPathFor(mediaComment.forwardedFrom, mediaComment.senderId, mediaComment.senderName))
    : "";

  // 按触发类型只给动态任务；发言/贴纸/反应的统一行动规则常驻 system prompt
  // （见 replyModel.ts 与 aiChat/ai/tools/replyToolset/）。
  // - 拿媒体直接叫机器人：对方用贴纸/图片/GIF 回复机器人，或在 caption 里
  //   @ 机器人（见 MediaCommentContext 的 directTriggerReason），语气同
  //   回复/@ 触发；描述可能是解析结果，也可能是元数据兜底。
  // - 媒体评价：针对刚解析完的那份图片/贴纸/GIF 发表评价，要求挂回复引用；
  //   评不出花来就简短一句，或至少扣个表情反应。
  // - 排队补跑：点名回复入队时快照下来的那条具体消息；上一轮的回复已覆盖它
  //   且没有新内容时直接结束。
  // - 随机插话：没有人在叫机器人，是否挂 reply_to_trigger、是否称呼对方由模型
  //   自主判断，但必须留下回应；触发者身份从转录最后一行读取。
  // - 回复/@ 触发：对方明确在跟机器人说话，建议第一条挂引用。
  const replyInstruction: string = mediaComment?.directTriggerReason === "reply"
    ? mediaReplyTriggerInstruction(mediaComment, mediaForwardNotice)
    : mediaComment?.directTriggerReason === "mention"
    ? mediaMentionTriggerInstruction(mediaComment, mediaForwardNotice)
    : mediaComment
    ? mediaCommentInstruction(mediaComment, mediaForwardNotice, mediaTagHintFor(mediaComment.kind))
    : queuedTrigger
    ? queuedTriggerInstruction(describeQueuedTrigger(queuedTrigger, rendered))
    : isRandomTrigger
    ? RANDOM_TRIGGER_INSTRUCTION
    : DIRECT_TRIGGER_INSTRUCTION;

  // 自身用户名使用启动身份快照；生命周期约束见 docs/cn/04-invariants.md。
  const selfIdentity: string = selfIdentityStatement(selfInfo.id, selfInfo.username);

  // 冷记忆段：更早的历史按每轮 COMPACT_BATCH_SIZE 条压缩成摘要（从旧到新），
  // 只作长期背景，不参与判断当前状态（两层仲裁见 consts/aiChat/prompts/memory.ts
  // 的 CHAT_MEMORY_PRIORITY_INSTRUCTION）。摘要入队时已压成单行（见
  // compaction.ts 的 summarizeBatch）。三个区块内只留 [BEGIN]/[END] 标签和
  // 段首职责标注，转录防注入总规则在 systemInstruction 声明（见
  // REPLY_CONTEXT_STRUCTURE_INSTRUCTION）。
  const summaryQueue: BoundedDeque<string> | undefined = chatSummaries.get(chatId);
  const summaries: string[] = summaryQueue ? summaryQueue.last(MAX_SUMMARY_ROUNDS) : [];
  const summaryBlock: string = buildColdMemoryBlock(summaries);
  const referenceMemory: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header +
    "\n" +
    selfIdentity +
    "\n\n" +
    (summaryBlock || REPLY_CONTEXT_SECTION_TEXT.referenceMemory.emptyContent) +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]`;
  const conversationHead: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.currentConversation.header +
    "\n";
  const currentConversation: string =
    conversationHead +
    rendered.text +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]`;
  const currentConversationSettledOffsets: number[] = [];
  for (const offset of rendered.settledOffsets) currentConversationSettledOffsets.push(conversationHead.length + offset);
  // 唤起者声明给出本轮「正在跟你说话的是谁」；热区读取、身份定位与同名/转发边界
  // 由系统提示词的 DIRECT_INVOCATION_READING_INSTRUCTION 规定。随机插话与随机媒体
  // 评价没有唤起者，整句不出现。整段缓存里都找不到 TA 时只报 id。
  const invokerSnapshot: AiSpeakerSnapshot | undefined = directInvokerId === undefined
    ? undefined
    : resolveInvoker(recent, triggerMessage, directInvokerId);
  const invokerLine: string = directInvokerId === undefined
    ? ""
    : directInvokerSentence(
      invokerSnapshot ? formatSpeakerIdentity(invokerSnapshot, selfInfo.id) : `[id:${directInvokerId}]`,
      // 转录行内只有编号，一并给出该编号。
      rendered.codeOf.get(directInvokerId) ?? ""
    ) + "\n";
  const replyTask: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.replyTask.header +
    "\n" +
    invokerLine +
    replyInstruction +
    // 不出错的轮次不拼这一段（见 consts/aiChat/prompts/tools.ts）。
    (roundHasTypo ? "\n\n" + TYPO_REQUIRED_INSTRUCTION : "") +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`;
  return { referenceMemory, currentConversation, currentConversationSettledOffsets, replyTask };
}
