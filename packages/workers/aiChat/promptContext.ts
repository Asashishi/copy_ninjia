import type { LinkedQueue } from "../../libs/linkedQueue";
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
  forwardPathTemplate,
  SELF_ROSTER_CODE,
} from "../../consts/aiChat/prompts/transcript";
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

/** 按媒体类型给出提示词里要用的名词短语与转录行标签，见 replyInstruction
 *  的拼装。 */
function mediaNounFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return "一枚贴纸";
    case "animation":
      return "一个 GIF（动图）";
    case "voice":
      return "一条语音";
    default:
      return "一张图片";
  }
}
/** 复用 mediaText.ts 的 resolvedTagFor 作为标签格式的唯一权威来源，用占位
 *  描述"…"代入即得到提示词里要展示的标签样式，与转录里实际写入的标签
 *  格式保证不会各改各的漂移。 */
function mediaTagHintFor(kind: MediaKind): string {
  return resolvedTagFor(kind, "…");
}

/** 用稳定 id 标出转发者，方向固定为「原始来源 → 当前群发送者」。 */
function forwardPathFor(origin: string | undefined, senderId: number, senderName: string): string {
  return origin ? forwardPathTemplate(origin, `[id:${senderId}] ${senderName}`) : "";
}

/**
 * 唤起者的完整身份快照。协议只把 id 传过来，first/last name 与 username 从
 * 逐字缓存回填——转录行用的就是这同一份快照，两处身份因此必然同形，不会出现
 * 「任务里叫一个名字、转录里叫另一个」。
 *
 * 先认触发消息本身：它就是 TA 刚发的那条，身份最新。触发消息已滑出逐字区
 * （排队补跑等到现在、媒体轮解析耗时久）时，从缓存尾部往回找 TA 最近的一条；
 * 常见情形第一次比较就命中，扫到头只发生在整段缓存里都没有 TA 的时候，那时
 * 返回 undefined 由调用方退回只报 id。
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
   *  评价省略。用于在回复任务开头声明「正在跟你说话的是谁」——身份段按这个
   *  id 从逐字缓存里回填 first/last name 与 username，见 resolveInvoker。 */
  directInvokerId?: number;
  /** 是否是随机插话触发（见 replyPipeline.ts 的 generateAndSendReply 的
   *  isRandomTrigger）：没有人在叫机器人，怎么接（挂不挂 reply_to_trigger、
   *  要不要称呼对方）由模型自主判断，但必须回应（说话/贴纸/扣反应都算）——
   *  「插不插话」的闸门在触发概率那一层，命中了就要留下点动静。 */
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
   *  模型之前掷一次骰子决定（见 consts/aiChat/tools.ts 的 AI_TEXT_TYPO_PROBABILITY）。
   *  为 true 时才在回复指令末尾拼上 TYPO_REQUIRED_INSTRUCTION；为 false 时
   *  完全不提错字这回事，两个分支的提示词严格分开。同一个值也传给
   *  createReplyToolset（ReplyToolContext.roundHasTypo），两处必须用同一次
   *  掷骰结果。 */
  roundHasTypo: boolean;
}

/**
 * 把某群的对话上下文拼装成三个职责固定的模型输入区块：只读参考记忆、只读
 * 当前会话和本轮回复任务。replyModel.ts 会保持这个顺序，交由实现包映射成同一个
 * user Content 下的三个 text Part，而不是伪造成 user/model 历史轮次。
 * @param chatId 群聊 ID。
 * @param selfInfo 机器人自己的账号身份（见 cache/workers/aiChat/identity.ts 的 botInfoState），用于转录里的自我认知。
 * @returns 拼好的三个区块；缓存为空时返回 null。
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
  // selfId 让机器人自己的行拿到固定编号（不必回名册查自己是谁）；triggerMessageId
  // 保住触发消息的消息号。
  const rendered: RenderedTranscript = buildTieredVerbatimTranscript(recent, {
    selfId: selfInfo.id,
    triggerMessageId,
  });
  const triggerMessage: BufferedMessage | undefined = lookupBufferedMessage(chatId, triggerMessageId);
  const queuedReplyReference: string = queuedTrigger?.replyTo
    ? `；那条消息${rendered.replyReference(queuedTrigger.replyTo)}`
    : "";
  const mediaForwardPath: string = mediaComment
    ? forwardPathFor(mediaComment.forwardedFrom, mediaComment.senderId, mediaComment.senderName)
    : "";
  const mediaForwardNotice: string = mediaForwardPath ? `这份内容是转发来的，${mediaForwardPath}；` : "";
  const queuedSenderName: string = queuedTrigger?.senderName || "有人";
  const queuedForwardPath: string = queuedTrigger
    ? forwardPathFor(queuedTrigger.forwardedFrom, queuedTrigger.triggerSenderId, queuedSenderName)
    : "";
  const queuedTriggerDescription: string = queuedTrigger
    ? queuedForwardPath
      ? `${queuedSenderName} 转发了一条给你的内容，那条就是本轮的触发消息（${queuedForwardPath}；转发正文：「${queuedTrigger.text}」${queuedReplyReference}）`
      : `${queuedSenderName} 也在跟你说话，那条就是本轮的触发消息（TA 说的是：「${queuedTrigger.text}」${queuedReplyReference}）`
    : "";

  // 按触发类型只给动态任务；发言/贴纸/反应的统一行动规则常驻 system prompt，
  // 不在每种任务后重复（见 replyModel.ts 与 aiChat/ai/tools/replyToolset/）。
  // - 拿媒体直接叫机器人：对方用贴纸/图片/GIF 回复机器人，或在 caption 里
  //   @ 机器人（见 MediaCommentContext 的 directTriggerReason），语气同
  //   回复/@ 触发——别已读不回；描述可能是解析结果也可能是元数据兜底，模型
  //   按有什么接什么。
  // - 媒体评价：针对刚解析完的那份图片/贴纸/GIF 发表评价，要求挂回复引用；
  //   评不出花来就简短一句、或至少扣个表情反应，不允许沉默。
  // - 排队补跑：点名回复入队时快照下来的那条具体消息（此刻转录尾部早已
  //   是别的消息，不能说「最新这条」）；上一轮的回复可能已顺带覆盖它，
  //   覆盖过且没有新内容就直接结束。
  // - 随机插话：没有人在叫机器人，怎么接（挂不挂 reply_to_trigger、要不要
  //   称呼对方）由模型自主判断，但必须留下回应；触发者身份从转录最后一行读取。
  // - 回复/@ 触发：对方明确在跟机器人说话，别已读不回，建议第一条挂引用。
  const replyInstruction: string = mediaComment?.directTriggerReason === "reply"
    ? `刚才 ${mediaComment.senderName} 用${mediaNounFor(mediaComment.kind)}回复了你上一条消息。${mediaForwardNotice}内容是：「${mediaComment.description}」。TA 是在跟你说话，别已读不回——请结合这份内容和你们正聊的话题，以你的人设自然接住，通常一两句话就够；建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。`
    : mediaComment?.directTriggerReason === "mention"
    ? `刚才 ${mediaComment.senderName} 发了${mediaNounFor(mediaComment.kind)}并在配文里 @ 了你。${mediaForwardNotice}内容是：「${mediaComment.description}」。TA 是在跟你说话，别已读不回——请结合这份内容和你们正聊的话题，以你的人设自然接住，通常一两句话就够；建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。`
    : mediaComment
    ? `刚才 ${mediaComment.senderName} 在群里发了${mediaNounFor(mediaComment.kind)}。${mediaForwardNotice}内容是：「${mediaComment.description}」（聊天记录里对应「${mediaTagHintFor(mediaComment.kind)}」那行）。请以你的人设，针对这份内容本身发表一两句评价/吐槽/调侃——自然一点，不要机械复述描述，也不要提"描述"两个字。第一条消息请把 reply_to_trigger 设为 true，让评价以「回复」形式挂在那条消息上；评不出花来，简短一句也行，或者至少给那条消息扣个表情反应。`
    : queuedTrigger
    ? `刚才你忙着回别的消息的时候，${queuedTriggerDescription}，这条是排队等到现在才轮到处理的。请针对这条消息、以你的人设自然接住话题，建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让对方知道你在回哪条；如果你后来的发言其实已经回应过这条、或者话题早就翻篇了，且没有新内容，就直接结束，不要换个说法再答一次，也不要为补回应额外发言或扣反应。`
    : isRandomTrigger
    ? "群里最新这条消息并没有人在叫你——只是你自己刷到了，想插一嘴：请以你的人设自然接住话题（要不要挂 reply_to_trigger、要不要在文字里称呼对方，都按怎么自然怎么来）；哪怕话题跟你关系不大，也要留下点回应——一句吐槽或感想都行，实在没话就扣个表情反应。"
    : "请针对最新这条消息，以你的人设自然接住话题——通常一到两句话就够，想连发几条短句也随你。对方是在跟你说话，别已读不回；建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。";

  // 明确告诉模型「你自己」在这个群里的账号身份：转录里 @ 你的 username、
  // 回复你的消息、以及标着你自己 id 的行（见发送后的 recordChatMessage 自录）
  // 都要能认出来是你自己，不能当成第三个人。username/id 来自主线程在
  // bot.init() 之后注入的 init 消息（见 cache/workers/aiChat/identity.ts 的 botInfoState），不写死在代码里。
  const selfIdentity: string =
    `本群中你的 Telegram 账号身份是 @${selfInfo.username}（[id:${selfInfo.id}]）。` +
    `转录里编号写作「${SELF_ROSTER_CODE}」的行就是你自己之前说过的话（行内不会再出现这个 id）；` +
    `消息里 @ 这个用户名、或回复这个账号的消息，指向的对象都是你。`;

  // 冷记忆段：更早的历史按每轮 COMPACT_BATCH_SIZE 条压缩成摘要（从旧到
  // 新），只作为长期背景纳入理解，不参与判断当前状态（两层仲裁见
  // consts/aiChat/prompts/memory.ts 的 CHAT_MEMORY_PRIORITY_INSTRUCTION）；
  // 摘要行不会被误当成逐字聊天记录。摘要入队时已压成单行（见
  // compaction.ts 的 summarizeBatch），「一行一条」的防伪造结构同样成立。
  // 三个区块内只留 [BEGIN]/[END] 标签和段首职责标注，防注入总规则统一在
  // systemInstruction 声明（见 REPLY_CONTEXT_STRUCTURE_INSTRUCTION）。
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
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
  const currentConversation: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.currentConversation.header +
    "\n" +
    rendered.text +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]`;
  // 唤起者声明是本轮「正在跟你说话的是谁」的唯一可信来源；热区读取、身份定位
  // 与同名/转发边界由系统提示词的 DIRECT_INVOCATION_READING_INSTRUCTION 规定。
  // 随机插话与随机媒体评价没有唤起者，整句不出现，模型据此判断本轮无人叫它。
  // 整段缓存里都找不到 TA 时退回只报 id：名字宁可缺，也不能拿别处的名字凑。
  const invokerSnapshot: AiSpeakerSnapshot | undefined = directInvokerId === undefined
    ? undefined
    : resolveInvoker(recent, triggerMessage, directInvokerId);
  const invokerLine: string = directInvokerId === undefined
    ? ""
    : directInvokerSentence(
      invokerSnapshot ? formatSpeakerIdentity(invokerSnapshot) : `[id:${directInvokerId}]`,
      // 转录行内只有编号：不把它一起给出，模型就得拿 id 回名册做一次连接查询。
      rendered.codeOf.get(directInvokerId) ?? ""
    ) + "\n";
  const replyTask: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.replyTask.header +
    "\n" +
    invokerLine +
    replyInstruction +
    // 不出错的轮次完全不拼这一段——两个分支的提示词严格分开，模型看不到
    // 「本来可能出错」这件事（见 consts/aiChat/prompts/tools.ts）。
    (roundHasTypo ? "\n\n" + TYPO_REQUIRED_INSTRUCTION : "") +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`;
  return { referenceMemory, currentConversation, replyTask };
}
