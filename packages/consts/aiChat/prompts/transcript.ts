/** 群聊转录行内标注的共享模板。拼装侧（aiChat/ai/utils/chatTranscript.ts 的
 * formatReplyReference/formatForwardTag）与说明文案侧（本目录 memory.ts 的
 * SUMMARY_SYSTEM_PROMPT、转录段首格式说明）共用同一模板，防止格式与说明
 * 各改各的漂移；说明里引用的占位形态直接以「…」代入模板生成，参照
 * workers/aiChat/mediaText.ts 的 resolvedTagFor 与 mediaTagHintFor。 */

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

/** 转发来源标注模板。origin 是预格式化的来源身份（见 auto/message/facts.ts
 * 的 resolveForwardOrigin）。 */
export function forwardTagTemplate(origin: string): string {
  return `（转发自 ${origin}）`;
}

/** 本轮回复任务使用的完整转发路径。origin 是原始来源，forwarder 是把内容
 * 带进当前群的发送者；箭头方向固定为「来源 → 转发者」。 */
export function forwardPathTemplate(origin: string, forwarder: string): string {
  return `转发路径：「${origin} → ${forwarder}」`;
}

/** 回复链中已滑出逐字热区、只剩上一跳回复快照的链尾标记。 */
export const REPLY_CHAIN_SNAPSHOT_TAG: string = "[仅回复快照]";

/** 多层回复链标注模板。triggerMessageId 是本轮触发消息的 message_id，links
 *  是已格式化的各跳行——第 1 行是触发消息直接回复的对象，逐级向更早追溯
 *  （见 aiChat/ai/utils/chatTranscript.ts 的 formatReplyChain）。 */
export function replyChainTemplate(triggerMessageId: number, links: string[]): string {
  return (
    `补充：本轮触发消息（[message_id:${triggerMessageId}]）处在一条多层回复链上——它回复了下面第 1 条，第 1 条又回复了第 2 条，依此类推。` +
    `链沿仍在逐字聊天记录内的消息回溯；若最后一跳标有 ${REPLY_CHAIN_SNAPSHOT_TAG}，它是上一条消息自带的回复快照，原消息已不在逐字记录中。` +
    "各跳正文超长时会截断；除链尾快照外，完整原文以逐字记录为准。理解话题走向和人物指代时请顺着这条链看：\n" +
    links.map((link: string, index: number): string => `${index + 1}. ${link}`).join("\n")
  );
}

/** 转录行基础格式的占位形态。逐字转录段首的格式说明（aiChat/ai/utils/chatTranscript.ts
 * 的 buildTieredVerbatimTranscript）与压缩摘要系统提示（本目录 memory.ts 的
 * SUMMARY_SYSTEM_PROMPT）共用同一字符串，防止行格式与说明各改各的漂移；
 * 实际行的拼装见 aiChat/ai/utils/chatTranscript.ts 的 formatBufferedMessageLine。 */
export const TRANSCRIPT_LINE_FORMAT_HINT: string =
  "「[年/月/日 时:分:秒] [message_id:消息ID] [id:用户ID] [username:@公开用户名] 名字：内容」";

/** 说明文案里引用的两种标注占位形态。 */
export const REPLY_TAG_HINT: string = replyTagTemplate({ target: "[message_id:…] …", text: "…", forwardTag: "", quote: "" });
/** 说明文案引用的转发来源占位形态。 */
export const FORWARD_TAG_HINT: string = forwardTagTemplate("…");

/**
 * 机器人自己动作在转录里的记号——这些行由**执行侧在动作真正落地之后**写入
 * （见 aiChat/ai/tools/replyToolset/imageGeneration.ts 与 aiChat/ai/stickers/describe.ts 的自录），
 * 模型只能读到、绝不能自己产出。
 *
 * 两个模板与下面的 SELF_ACTION_TAG_MARKERS 必须共用同一份字面量：记号是
 * 「这个动作确实发生过」的唯一凭据，执行侧写一份、拦截侧再手抄一份，两边一漂移
 * 就等于凭据失效。生图撞上群冷却时模型有概率不说「发不了」，而是照着转录里见过
 * 的这个形状用 send_message 打一段「（…生成并发送了一张图片：…）」出来——群友看到
 * 的是一条声称配了图、实际什么都没有的消息，而记忆里也会留下一条假的动作记录。
 */
export function stickerSentTagTemplate(detail: string): string {
  return detail ? `（${SELF_STICKER_TAG_MARKER}：${detail}）` : `（${SELF_STICKER_TAG_MARKER}）`;
}

/** 同上，生图动作的记号。reference 为真时说明本次带了参考素材。 */
export function imageSentTagTemplate(prompt: string, reference: boolean): string {
  return `（${reference ? "参考素材" : ""}${SELF_IMAGE_TAG_MARKER}：${prompt}）`;
}

/** 同上，生歌动作的记号。 */
export function songSentTagTemplate(prompt: string): string {
  return `（${SELF_SONG_TAG_MARKER}：${prompt}）`;
}

/** 贴纸自录记号的固定词。 */
const SELF_STICKER_TAG_MARKER: string = "发了一枚贴纸";
/** 生图自录记号的固定词。 */
const SELF_IMAGE_TAG_MARKER: string = "生成并发送了一张图片";
/** 生歌自录记号的固定词。 */
const SELF_SONG_TAG_MARKER: string = "生成并发送了一首歌";

/**
 * 拦截侧用的记号清单：只用来把命中的那个词写进报错文案，判定看的是下面的
 * SELF_ACTION_TAG_PATTERNS。
 */
export const SELF_ACTION_TAG_MARKERS: readonly string[] = [
  SELF_STICKER_TAG_MARKER,
  SELF_IMAGE_TAG_MARKER,
  SELF_SONG_TAG_MARKER,
];

/**
 * 拦截侧的判定式：模型给 send_message 的正文里命中其中任何一条，就是在用文字
 * 伪造一次执行侧动作，必须拒发（见 aiChat/ai/tools/replyToolset/sendMessage.ts）。
 *
 * 锚定的是上面两个模板的**整体形状**而不是裸短语：记号要出现在一对全角括号
 * 里、紧跟着 `：` 或收尾的 `）`，中间只允许一小段没跨过 `）` 的前缀（模型仿写
 * 时会把「参考素材」改成「参考上传的素材」这类说法，只认字面模板等于没拦）。
 *
 * 不能用裸子串：「发了一枚贴纸」「生成并发送了一张图片」本身都是日常中文，
 * 群友问一句「你刚刚生成并发送了一张图片吗？」模型照常作答就会命中而被硬拒，
 * 本轮兜底文本走的又是同一个执行器、会被再拒一次，结果是对着一条 @ 提及完全
 * 沉默。括号外提到这两个词一律放行，括号内摆成凭据形状的一律拦下。
 */
export const SELF_ACTION_TAG_PATTERNS: readonly RegExp[] = [
  new RegExp(`（[^）]{0,20}${SELF_STICKER_TAG_MARKER}(?:：|）)`),
  new RegExp(`（[^）]{0,20}${SELF_IMAGE_TAG_MARKER}(?:：|）)`),
  new RegExp(`（[^）]{0,20}${SELF_SONG_TAG_MARKER}(?:：|）)`),
];

/** 说明文案里引用的贴纸自录占位形态。 */
export const STICKER_SENT_TAG_HINT: string = stickerSentTagTemplate("…");
/** 说明文案里引用的生图自录占位形态。 */
export const IMAGE_SENT_TAG_HINT: string = imageSentTagTemplate("…", false);
/** 说明文案里引用的生歌自录占位形态。 */
export const SONG_SENT_TAG_HINT: string = songSentTagTemplate("…");
