import type { BotImageOrigin } from "../../../types/aiChat/memory";
import { COMPACT_BATCH_SIZE } from "../memory";

/** 群聊转录行内标注与区块名的共享模板。拼装侧（aiChat/ai/utils/chatTranscript.ts 的
 * formatReplyReference/formatForwardTag 与各区块标题）与说明文案侧（本目录 memory.ts 的
 * SUMMARY_SYSTEM_PROMPT、转录段首格式说明、记忆仲裁与禁言指令）共用同一模板；
 * 说明里引用的占位形态直接以「…」代入模板生成，参照
 * workers/aiChat/mediaText.ts 的 resolvedTagFor 与 workers/aiChat/promptContext.ts
 * 的 mediaTagHintFor。 */

/** 回复标注模板。target 是被回复者的完整身份段（[message_id:]/[id:] 等标记
 * 加显示名）；forwardTag/quote 传空串表示省略对应段。 */
export interface ReplyTagTemplateParams {
  target: string;
  text: string;
  forwardTag: string;
  quote: string;
}

export function replyTagTemplate(parts: ReplyTagTemplateParams): string {
  return `（回复 ${parts.target} 的消息${parts.forwardTag}：「${parts.text}」${parts.quote}）`;
}

/** 转发来源标注模板。origin 在压缩摘要那条路上是预格式化的来源身份（见
 * auto/message/facts.ts 的 resolveForwardOrigin），在回复转录里是来源名册
 * 里的编号（f1、f2……，见 aiChat/ai/utils/chatTranscript.ts 的
 * buildTieredVerbatimTranscript）——两侧共用同一个外壳，模型只需认一种形状。 */
export function forwardTagTemplate(origin: string): string {
  return `（转发自 ${origin}）`;
}

/** 紧凑转录的日期分隔行：其后的行都属于这一天，行内因此只留时分秒。
 *  每个分层区块开头都重发一次当前日期。 */
export function transcriptDateHeader(date: string): string {
  return `── ${date} ──`;
}

/** 名册条目：`编号=完整身份`。转录行内只写编号，身份只在名册里出现一次。 */
export function rosterEntryTemplate(code: string, identity: string): string {
  return `${code}=${identity}`;
}

/** 区块名的方括号外壳：`【名称】`，带说明时为 `【名称（说明）】`。 */
function blockTitle(name: string, note?: string): string {
  return note === undefined ? `【${name}】` : `【${name}（${note}）】`;
}

/** 逐字转录里最新一段（至多 COMPACT_BATCH_SIZE 条）的分层名；所属模块：本文件的区块名与区块标题。 */
const HOT_MEMORY_TIER_NAME: string = "最热记忆";
/** 逐字转录里排在最热记忆之前那一段的分层名；所属模块：本文件的区块名与区块标题。 */
const EARLIER_VERBATIM_TIER_NAME: string = "较早逐字记录";
/** 更早对话压缩摘要的分层名；所属模块：本文件的区块名与区块标题。 */
const COLD_MEMORY_TIER_NAME: string = "冷记忆";

/** 最热记忆的区块名；本目录 memory.ts 的读法说明、仲裁规则、防注入白名单与禁言指令引用它。 */
export const HOT_MEMORY_BLOCK_NAME: string = blockTitle(HOT_MEMORY_TIER_NAME);
/** 较早逐字记录的区块名；引用方同 HOT_MEMORY_BLOCK_NAME。 */
export const EARLIER_VERBATIM_BLOCK_NAME: string = blockTitle(EARLIER_VERBATIM_TIER_NAME);
/** 冷记忆的区块名；引用方同 HOT_MEMORY_BLOCK_NAME，另作冷记忆为空时的占位开头。 */
export const COLD_MEMORY_BLOCK_NAME: string = blockTitle(COLD_MEMORY_TIER_NAME);
/** 发言人名册的区块名；拼装侧（aiChat/ai/utils/chatTranscript.ts 的 buildRosterBlock）与 memory.ts 的说明文案共用。 */
export const SPEAKER_ROSTER_BLOCK_NAME: string = blockTitle("发言人名册");
/** 转发来源名册的区块名；共用方同 SPEAKER_ROSTER_BLOCK_NAME。 */
export const FORWARD_ROSTER_BLOCK_NAME: string = blockTitle("转发来源名册");

/**
 * 较早逐字记录区块的标题与读法，其后紧跟该段转录行；只在逐字缓存超出一个压缩块时出现。
 * 所属模块：aiChat/ai/utils/chatTranscript.ts 的 buildTieredVerbatimTranscript。
 */
export const EARLIER_VERBATIM_BLOCK_HEADER: string =
  `${blockTitle(EARLIER_VERBATIM_TIER_NAME, "次要背景")}这些记录仍是原文，但判断当前话题和应答对象时应让位于下方${HOT_MEMORY_TIER_NAME}：\n`;
/**
 * 最热记忆区块的标题与读法，其后紧跟该段转录行；标题里的条数与分层边界的上限
 * COMPACT_BATCH_SIZE 一致。所属模块：aiChat/ai/utils/chatTranscript.ts 的 buildTieredVerbatimTranscript。
 */
export const HOT_MEMORY_BLOCK_HEADER: string =
  `${blockTitle(HOT_MEMORY_TIER_NAME, `重要判断标准，最新最多 ${COMPACT_BATCH_SIZE} 条`)}这是滑动缓存里最新、最应优先关注的逐字消息。` +
  "判断当前话题、人物指代、@对象、情绪和该回应谁时，必须优先依据本段；最后一条是最新消息：\n";
/**
 * 冷记忆区块的标题与读法，其后紧跟按时间从旧到新编号的摘要。
 * 所属模块：aiChat/ai/utils/chatTranscript.ts 的 buildColdMemoryBlock。
 */
export const COLD_MEMORY_BLOCK_HEADER: string =
  `${blockTitle(COLD_MEMORY_TIER_NAME, "长期背景")}下列内容是更早对话的压缩摘要（按时间从旧到新），只用于理解长期话题、称呼、人物关系和前因后果，不用于判断当前状态；` +
  "它与较新的逐字记录不一致时，只说明情况后来变了，当前状态以逐字记录为准：\n";

/** 机器人自己在名册里的固定编号，不参与 u1/u2 排号。 */
export const SELF_ROSTER_CODE: string = "me";

/** AI 上下文中本机器人发言的唯一代称；仅按自身账号 ID 使用，转录身份不展示 Telegram 姓名或用户名。 */
export const SELF_SPEAKER_NAME: string = "自己（也就是你）";

/** 转录行上的消息号，只出现在「本段里被别人回复过」和本轮触发消息这两类行上。 */
export function messageNumberTag(messageId: number | string): string {
  return `#${messageId}`;
}

/** 紧凑转录里的回复指针：被回复的消息就在同一段转录里，作者与原文见那一行，
 *  不内嵌副本。 */
export function replyPointerTemplate(messageId: number | string): string {
  return `（回复 ${messageNumberTag(messageId)}）`;
}

/** 精确引用片段的正文：用户手选的那一段。 */
function replyQuoteBody(quote: string): string {
  return `精确引用片段：「${quote}」`;
}

/** 指针后附的独立标注，自带括号；说明文案（REPLY_QUOTE_HINT）引用的也是这一形态。 */
export function replyQuoteTemplate(quote: string): string {
  return `（${replyQuoteBody(quote)}）`;
}

/**
 * 内嵌进 replyTagTemplate 的形态：外层已经有一对括号，这里只补分隔符。
 *
 * 与上面那条共用同一份正文。
 */
export function replyQuoteInlineTemplate(quote: string): string {
  return `；${replyQuoteBody(quote)}`;
}

/** 说明文案里引用的精确引用片段占位形态。 */
export const REPLY_QUOTE_HINT: string = replyQuoteTemplate("…");

/** 被回复目标已滑出逐字窗口时的标记：本段里没有对应行，使用内嵌快照。 */
export const REPLY_TARGET_EVICTED_TAG: string = "[已滑出]";

/** 本轮回复任务使用的完整转发路径。origin 是原始来源，forwarder 是把内容
 * 带进当前群的发送者；箭头方向固定为「来源 → 转发者」。 */
export function forwardPathTemplate(origin: string, forwarder: string): string {
  return `转发路径：「${origin} → ${forwarder}」`;
}

/** 自包含转录行的占位形态：压缩摘要那条路用的格式（本目录 memory.ts 的
 * SUMMARY_SYSTEM_PROMPT），实际拼装见 aiChat/ai/utils/chatTranscript.ts 的
 * formatBufferedMessageLine。两侧共用同一字符串。 */
export const TRANSCRIPT_LINE_FORMAT_HINT: string =
  "「[年/月/日 时:分:秒] [message_id:消息ID] [id:用户ID] [username:@公开用户名] 名字：内容」";

/** 一个人的完整身份段占位形态。名册条目用它，回复任务里点名唤起者也用它
 * （见 aiChat/ai/utils/chatTranscript.ts 的 formatSpeakerIdentity）。 */
export const TRANSCRIPT_IDENTITY_FORMAT_HINT: string = "[id:用户ID] [username:@公开用户名] 名字";

/** 紧凑转录行的占位形态：身份退化成名册编号，日期上提到分隔行，消息号按需出现。
 * 实际拼装见 aiChat/ai/utils/chatTranscript.ts 的 buildTieredVerbatimTranscript。 */
export const COMPACT_LINE_FORMAT_HINT: string = "「[时:分:秒] #消息号 发言人编号：内容」";

/** 说明文案里引用的消息号占位形态。 */
export const MESSAGE_NUMBER_HINT: string = messageNumberTag("消息号");
/** 说明文案里引用的回复指针占位形态。 */
export const REPLY_POINTER_HINT: string = replyPointerTemplate("消息号");
/** 说明文案里引用的「被回复消息已滑出」占位形态。 */
export const REPLY_EVICTED_HINT: string = replyTagTemplate({
  target: `${REPLY_TARGET_EVICTED_TAG} …`,
  text: "…",
  forwardTag: "",
  quote: "",
});

/** 说明文案里引用的两种标注占位形态。 */
export const REPLY_TAG_HINT: string = replyTagTemplate({ target: "[message_id:…] …", text: "…", forwardTag: "", quote: "" });
/** 说明文案引用的转发来源占位形态。 */
export const FORWARD_TAG_HINT: string = forwardTagTemplate("…");

/**
 * 机器人自己动作在转录里的记号——这些行由**执行侧在动作真正落地之后**写入
 * （见 aiChat/ai/tools/replyToolset/imageGeneration.ts、aiChat/ai/stickers/describe.ts、
 * aiChat/ai/tools/replyToolset/voiceMessage.ts 与 workers/aiChat/botImages.ts 的自录），
 * 模型只能读到、绝不能自己产出。
 *
 * 这些模板与下面的 SELF_ACTION_TAG_MARKERS 必须共用同一份字面量：记号是
 * 「这个动作确实发生过」的唯一凭据，拦截侧（send_message 正文校验，见
 * SELF_ACTION_TAG_PATTERNS）按同一批词判定伪造。
 */
export function stickerSentTagTemplate(detail: string): string {
  return detail ? `（${SELF_STICKER_TAG_MARKER}：${detail}）` : `（${SELF_STICKER_TAG_MARKER}）`;
}

/** 同上，生图动作的记号。reference 为真时说明本次带了参考素材。 */
export function imageSentTagTemplate(prompt: string, reference: boolean): string {
  return `（${reference ? "参考素材" : ""}${SELF_IMAGE_TAG_MARKER}：${prompt}）`;
}

/** 同上，语音动作的记号；text 是念出来的台词原文。 */
export function voiceSentTagTemplate(text: string): string {
  return `（${SELF_VOICE_TAG_MARKER}：${text}）`;
}

/** 同上，命令与定时任务发图的记号；description 为空串时是尚未识图的占位态。 */
function commandImageSentTagTemplate(description: string): string {
  return description ? `（${SELF_COMMAND_IMAGE_TAG_MARKER}：${description}）` : `（${SELF_COMMAND_IMAGE_TAG_MARKER}）`;
}

/**
 * 机器人自发图片按来源选记号：命令图用 commandImageSentTagTemplate，两种生图用
 * imageSentTagTemplate。detail 在占位态是生图提示词（命令图为空串），内容态是识图描述。
 */
export function botImageTagTemplate(origin: BotImageOrigin, detail: string): string {
  return origin === "command"
    ? commandImageSentTagTemplate(detail)
    : imageSentTagTemplate(detail, origin === "referenceGenerated");
}

/** 贴纸自录记号的固定词。 */
const SELF_STICKER_TAG_MARKER: string = "发了一枚贴纸";
/** 生图自录记号的固定词。 */
const SELF_IMAGE_TAG_MARKER: string = "生成并发送了一张图片";
/** 语音自录记号的固定词。 */
const SELF_VOICE_TAG_MARKER: string = "发送了一条语音";
/** 命令与定时任务发图自录记号的固定词。 */
const SELF_COMMAND_IMAGE_TAG_MARKER: string = "发送了一张图片";

/**
 * 拦截侧用的记号清单：只用来把命中的那个词写进报错文案，判定看的是下面的
 * SELF_ACTION_TAG_PATTERNS。
 */
export const SELF_ACTION_TAG_MARKERS: readonly string[] = [
  SELF_STICKER_TAG_MARKER,
  SELF_IMAGE_TAG_MARKER,
  SELF_VOICE_TAG_MARKER,
  SELF_COMMAND_IMAGE_TAG_MARKER,
];

/**
 * 拦截侧的判定式：模型给 send_message 的正文里命中其中任何一条，就是在用文字
 * 伪造一次执行侧动作，必须拒发（见 aiChat/ai/tools/replyToolset/sendMessage.ts）。
 *
 * 锚定的是上面这些模板的**整体形状**：记号出现在一对全角括号里、紧跟着 `：` 或
 * 收尾的 `）`，中间只允许一小段没跨过 `）` 的前缀（容许「参考素材」写成
 * 「参考上传的素材」这类变体）。括号外提到这些词一律放行，括号内摆成凭据形状的一律拦下。
 */
export const SELF_ACTION_TAG_PATTERNS: readonly RegExp[] = [
  new RegExp(`（[^）]{0,20}${SELF_STICKER_TAG_MARKER}(?:：|）)`),
  new RegExp(`（[^）]{0,20}${SELF_IMAGE_TAG_MARKER}(?:：|）)`),
  new RegExp(`（[^）]{0,20}${SELF_VOICE_TAG_MARKER}(?:：|）)`),
  new RegExp(`（[^）]{0,20}${SELF_COMMAND_IMAGE_TAG_MARKER}(?:：|）)`),
];

/** 说明文案里引用的贴纸自录占位形态。 */
export const STICKER_SENT_TAG_HINT: string = stickerSentTagTemplate("…");
/** 说明文案里引用的生图自录占位形态。 */
export const IMAGE_SENT_TAG_HINT: string = imageSentTagTemplate("…", false);
/** 说明文案里引用的语音自录占位形态。 */
export const VOICE_SENT_TAG_HINT: string = voiceSentTagTemplate("…");
/** 说明文案里引用的命令发图自录占位形态。 */
export const COMMAND_IMAGE_SENT_TAG_HINT: string = commandImageSentTagTemplate("…");
