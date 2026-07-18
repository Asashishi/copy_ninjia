import type { LinkedQueue } from "../../libs/linkedQueue";
import { sanitizeInline } from "../../libs/text";
import { buildColdMemoryBlock, buildTieredVerbatimTranscript } from "../../ai/utils/chatTranscript";
import {
  MAX_SUMMARY_ROUNDS,
  VERBATIM_CONTEXT_MAX,
} from "../../consts/aiChat";
import { CHAT_MEMORY_PRIORITY_INSTRUCTION, REPLY_ACTION_INSTRUCTION, TYPO_REQUIRED_INSTRUCTION } from "../../consts/aiChatPrompts";
import { chatBuffers, chatSummaries } from "../../cache/aiChat/memory";
import { resolvedTagFor } from "./mediaText";
import type { AiBotInfo, BufferedMessage, MediaKind, QueuedReplyTrigger } from "../../types";

/** 评价触发的附加上下文：发送人显示名 + 解析出的描述 + 媒体类型，见
 *  mediaIngest.ts 的 recordChatMedia。kind 决定拼进提示词的措辞（"一张图片"/
 *  "一枚贴纸"/"一个 GIF"）。 */
export interface MediaCommentContext {
  kind: MediaKind;
  senderName: string;
  description: string;
  /** 用户是拿这份媒体明确在跟机器人说话（回复机器人，或 caption 里 @ 机器人）：
   *  回复指令改为必回语气（不许已读不回），并发闸打满时按直接触发排队补跑
   *  而非丢弃。 */
  directTriggerReason?: "reply" | "mention";
}

/** 按媒体类型给出提示词里要用的名词短语与转录行标签，见 replyInstruction
 *  的拼装。 */
function mediaNounFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return "一枚贴纸";
    case "animation":
      return "一个 GIF（动图）";
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

/** buildUserContent 的可选附加上下文，按需组合，见各字段说明。 */
interface UserContentOptions {
  /** 若本次是「用户回复了机器人」，被回复的那条机器人消息文本，作为上下文
   *  （机器人自己发的消息不会作为更新推送回来，不在缓存里）。 */
  repliedBotText?: string;
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
   *  在转录尾部）；自己后来的发言已覆盖过它时换个说法简短接一句、或至少
   *  扣个反应，不允许沉默。 */
  queuedTrigger?: QueuedReplyTrigger;
  /** 本轮是否走「出错」分支：由 replyRound.ts 的 startReplyRound 在请求
   *  模型之前掷一次骰子决定（见 consts/aiChat.ts 的 AI_TEXT_TYPO_PROBABILITY）。
   *  为 true 时才在回复指令末尾拼上 TYPO_REQUIRED_INSTRUCTION；为 false 时
   *  完全不提错字这回事，两个分支的提示词严格分开。同一个值也传给
   *  createReplyToolset（ReplyToolContext.roundHasTypo），两处必须用同一次
   *  掷骰结果。 */
  roundHasTypo: boolean;
}

/**
 * 把某群的对话上下文拼装成给模型的用户消息内容：先声明记忆优先级，再放
 * 冷记忆摘要段（若有，最多 MAX_SUMMARY_ROUNDS 轮，从旧到新），最后把逐字
 * 缓存拆成「较早原文」与「最新 COMPACT_BATCH_SIZE 条最热记忆」两层；
 * 越热越靠近回复指令。
 * @param chatId 群聊 ID。
 * @param selfInfo 机器人自己的账号身份（见 cache/aiChat/identity.ts 的 botInfoState），用于转录里的自我认知。
 * @returns 拼好的用户消息内容；缓存为空时返回 null。
 */
export function buildUserContent(chatId: number, selfInfo: AiBotInfo, options: UserContentOptions): string | null {
  const { repliedBotText, isRandomTrigger, mediaComment, queuedTrigger, roundHasTypo } = options;
  const buf: LinkedQueue<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(VERBATIM_CONTEXT_MAX);
  const transcript: string = buildTieredVerbatimTranscript(recent);
  const trailingContext: string[] = [];
  if (repliedBotText) {
    // 同样压成单行：这段文本虽是机器人自己说过的话，保持转录「一行一条」的
    // 结构不变即可杜绝任何多行伪造的可能。
    trailingContext.push(`（你刚才说过：${sanitizeInline(repliedBotText)}）`);
  }

  // 按触发类型给引导，行动说明（REPLY_ACTION_INSTRUCTION）统一拼在最后：
  // 发言/贴纸/反应全部工具化，做什么、什么顺序由模型自己决定（见
  // ai/tools/replyToolset.ts）。
  // - 拿媒体直接叫机器人：对方用贴纸/图片/GIF 回复机器人，或在 caption 里
  //   @ 机器人（见 MediaCommentContext 的 directTriggerReason），语气同
  //   回复/@ 触发——别已读不回；描述可能是解析结果也可能是元数据兜底，模型
  //   按有什么接什么。
  // - 媒体评价：针对刚解析完的那份图片/贴纸/GIF 发表评价，要求挂回复引用；
  //   评不出花来就简短一句、或至少扣个表情反应，不允许沉默。
  // - 排队补跑：点名回复入队时快照下来的那条具体消息（此刻转录尾部早已
  //   是别的消息，不能说「最新这条」）；上一轮的回复可能已顺带覆盖它，
  //   覆盖过就换个说法简短接一句、或至少扣个表情反应表示看到了，不允许
  //   沉默、也别原样重复自己说过的话。
  // - 随机插话：没有人在叫机器人，怎么接（挂不挂 reply_to_trigger、要不要
  //   称呼对方）由模型自主判断，但必须留下回应——一句吐槽或感想，实在没话
  //   扣个表情反应也行；触发者是谁转录最后一行本来就写着，不再单独喂名字、
  //   不再强制点名。
  // - 回复/@ 触发：对方明确在跟机器人说话，别已读不回，建议第一条挂引用。
  const replyInstruction: string = mediaComment?.directTriggerReason === "reply"
    ? `刚才 ${mediaComment.senderName} 用${mediaNounFor(mediaComment.kind)}回复了你上一条消息，内容是：「${mediaComment.description}」。TA 是在跟你说话，别已读不回——请结合这份内容和你们正聊的话题，以你的人设自然接住，通常一两句话就够；建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。${REPLY_ACTION_INSTRUCTION}`
    : mediaComment?.directTriggerReason === "mention"
    ? `刚才 ${mediaComment.senderName} 发了${mediaNounFor(mediaComment.kind)}并在配文里 @ 了你，内容是：「${mediaComment.description}」。TA 是在跟你说话，别已读不回——请结合这份内容和你们正聊的话题，以你的人设自然接住，通常一两句话就够；建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。${REPLY_ACTION_INSTRUCTION}`
    : mediaComment
    ? `刚才 ${mediaComment.senderName} 在群里发了${mediaNounFor(mediaComment.kind)}，内容是：「${mediaComment.description}」（聊天记录里对应「${mediaTagHintFor(mediaComment.kind)}」那行）。请以你的人设，针对这份内容本身发表一两句评价/吐槽/调侃——自然一点，不要机械复述描述，也不要提"描述"两个字。第一条消息请把 reply_to_trigger 设为 true，让评价以「回复」形式挂在那条消息上；评不出花来，简短一句也行，或者至少给那条消息扣个表情反应。${REPLY_ACTION_INSTRUCTION}`
    : queuedTrigger
    ? `刚才你忙着回别的消息的时候，${queuedTrigger.senderName || "有人"} 也在跟你说话（TA 说的是：「${queuedTrigger.text}」，在聊天记录里能找到对应那行），这条是排队等到现在才轮到处理的。请针对 TA 那条消息、以你的人设自然接住话题，建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁；如果你后来的发言其实已经回应过这条、或者话题早就翻篇了，就换个说法简短接一句、或至少给 TA 那条消息扣个表情反应表示看到了，别原样重复自己说过的话。${REPLY_ACTION_INSTRUCTION}`
    : isRandomTrigger
    ? `群里最新这条消息并没有人在叫你——只是你自己刷到了，想插一嘴：请以你的人设自然接住话题（要不要挂 reply_to_trigger、要不要在文字里称呼对方，都按怎么自然怎么来）；哪怕话题跟你关系不大，也要留下点回应——一句吐槽或感想都行，实在没话就扣个表情反应。${REPLY_ACTION_INSTRUCTION}`
    : `请针对最新这条消息，以你的人设自然接住话题——通常一到两句话就够，想连发几条短句也随你。对方是在跟你说话，别已读不回；建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。${REPLY_ACTION_INSTRUCTION}`;

  // 明确告诉模型「你自己」在这个群里的账号身份：转录里 @ 你的 username、
  // 回复你的消息、以及标着你自己 id 的行（见发送后的 recordChatMessage 自录）
  // 都要能认出来是你自己，不能当成第三个人。username/id 来自主线程在
  // bot.init() 之后注入的 init 消息（见 cache/aiChat/identity.ts 的 botInfoState），不写死在代码里。
  const selfIdentity: string =
    `你在这个群里的 Telegram 账号是 @${selfInfo.username}（[id:${selfInfo.id}]）：` +
    `记录里标着这个 id 的行是你自己之前说过的话，别把它们当成别人的发言；` +
    `消息里 @ 这个用户名、或回复你的消息，都是在跟你说话。`;

  // 冷记忆段：更早的历史按每轮 COMPACT_BATCH_SIZE 条压缩成摘要（从旧到
  // 新），作为必须结合理解的长期背景，只在判断当前状态时低于较新的逐字
  // 记录；摘要行不会被误当成逐字聊天记录。摘要入队时已压成单行（见
  // compaction.ts 的 summarizeBatch），「一行一条」的防伪造结构同样成立。
  const summaryQueue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  const summaries: string[] = summaryQueue ? summaryQueue.last(MAX_SUMMARY_ROUNDS) : [];
  const summaryBlock: string = buildColdMemoryBlock(summaries);
  const trailingBlock: string = trailingContext.length > 0
    ? "\n\n【回复引用补充】\n" + trailingContext.join("\n")
    : "";

  return (
    CHAT_MEMORY_PRIORITY_INSTRUCTION +
    "\n" +
    selfIdentity +
    "\n\n" +
    summaryBlock +
    transcript +
    trailingBlock +
    "\n\n" +
    replyInstruction +
    // 不出错的轮次完全不拼这一段——两个分支的提示词严格分开，模型看不到
    // 「本来可能出错」这件事（见 consts/aiChatPrompts.ts 的 TYPO_REQUIRED_INSTRUCTION）。
    (roundHasTypo ? "\n\n" + TYPO_REQUIRED_INSTRUCTION : "")
  );
}
