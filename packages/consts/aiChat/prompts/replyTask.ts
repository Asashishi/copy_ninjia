import type { MediaCommentContext } from "../../../types/aiChat/replies";
import type { MediaKind } from "../../../types/media";
import { SILENT_REPLY_END_INSTRUCTION } from "./tools";
import { SELF_ROSTER_CODE, SELF_SPEAKER_NAME } from "./transcript";

/** 回复任务区块与只读参考记忆区块里按本轮触发拼装的文案模板。拼装与分支选择见
 * workers/aiChat/promptContext.ts 的 buildReplyPromptSections；回复任务区块属易变组，
 * 逐轮变化不影响前缀缓存。 */

/** 直接唤起类回复任务共用的尾句：建议第一条消息挂回复引用。所属模块：workers/aiChat/promptContext.ts。 */
const REPLY_TO_TRIGGER_SUGGESTION: string =
  "建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让 TA 知道你在回谁。";

/**
 * 拿媒体直接唤起机器人（回复机器人或配文 @）时共用的接话要求，接在媒体描述之后。
 * 所属模块：workers/aiChat/promptContext.ts。
 */
const MEDIA_DIRECT_TRIGGER_TAIL: string =
  "TA 是在跟你说话，别已读不回——请结合这份内容和你们正聊的话题，以你的人设自然接住，通常一两句话就够；" +
  REPLY_TO_TRIGGER_SUGGESTION;

/** 排队补跑的触发快照没有发送者名字时的称呼。所属模块：workers/aiChat/promptContext.ts。 */
export const QUEUED_TRIGGER_FALLBACK_SENDER_NAME: string = "有人";

/**
 * 随机插话的回复任务：没有人在叫机器人，是否挂 reply_to_trigger、是否称呼对方由模型
 * 自主判断，但必须留下回应。所属模块：workers/aiChat/promptContext.ts。
 */
export const RANDOM_TRIGGER_INSTRUCTION: string =
  "群里最新这条消息并没有人在叫你——只是你自己刷到了，想插一嘴：请以你的人设自然接住话题（要不要挂 reply_to_trigger、要不要在文字里称呼对方，都按怎么自然怎么来）；哪怕话题跟你关系不大，也要留下点回应——一句吐槽或感想都行，实在没话就扣个表情反应。";

/** 回复/@ 触发的回复任务：对方明确在跟机器人说话。所属模块：workers/aiChat/promptContext.ts。 */
export const DIRECT_TRIGGER_INSTRUCTION: string =
  "请针对最新这条消息，以你的人设自然接住话题——通常一到两句话就够，想连发几条短句也随你。对方是在跟你说话，别已读不回；" +
  REPLY_TO_TRIGGER_SUGGESTION;

/** 按媒体类型给出提示词里用的名词短语。 */
export function mediaNounFor(kind: MediaKind): string {
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

/** 媒体是转发来的时，接在媒体描述之前的说明；forwardPath 为空串（不是转发）时返回空串。 */
export function forwardedMediaNotice(forwardPath: string): string {
  return forwardPath ? `这份内容是转发来的，${forwardPath}；` : "";
}

/** queuedTriggerDescription 的入参。forwardPath 与 replyReference 为空串表示省略对应段。 */
export interface QueuedTriggerDescriptionOptions {
  readonly senderName: string;
  /** 完整转发路径（见 ./transcript.ts 的 forwardPathTemplate）；不是转发时为空串。 */
  readonly forwardPath: string;
  readonly text: string;
  /** 那条消息自身的回复标注；它没有回复别人时为空串。 */
  readonly replyReference: string;
}

/** 排队补跑时对入队快照那条触发消息的描述，嵌进 queuedTriggerInstruction。 */
export function queuedTriggerDescription({
  senderName,
  forwardPath,
  text,
  replyReference,
}: QueuedTriggerDescriptionOptions): string {
  const replySuffix: string = replyReference ? `；那条消息${replyReference}` : "";
  return forwardPath
    ? `${senderName} 转发了一条给你的内容，那条就是本轮的触发消息（${forwardPath}；转发正文：「${text}」${replySuffix}）`
    : `${senderName} 也在跟你说话，那条就是本轮的触发消息（TA 说的是：「${text}」${replySuffix}）`;
}

/** 拿媒体回复机器人上一条消息时的回复任务；forwardNotice 来自 forwardedMediaNotice。 */
export function mediaReplyTriggerInstruction(comment: MediaCommentContext, forwardNotice: string): string {
  return `刚才 ${comment.senderName} 用${mediaNounFor(comment.kind)}回复了你上一条消息。${forwardNotice}内容是：「${comment.description}」。` +
    MEDIA_DIRECT_TRIGGER_TAIL;
}

/** 发媒体并在配文里 @ 机器人时的回复任务；forwardNotice 来自 forwardedMediaNotice。 */
export function mediaMentionTriggerInstruction(comment: MediaCommentContext, forwardNotice: string): string {
  return `刚才 ${comment.senderName} 发了${mediaNounFor(comment.kind)}并在配文里 @ 了你。${forwardNotice}内容是：「${comment.description}」。` +
    MEDIA_DIRECT_TRIGGER_TAIL;
}

/**
 * 随机媒体评价的回复任务：针对刚解析完的那份媒体发表评价并挂回复引用。tagHint 是聊天
 * 记录里对应那行的占位标签样式（见 workers/aiChat/promptContext.ts 的 mediaTagHintFor）。
 */
export function mediaCommentInstruction(comment: MediaCommentContext, forwardNotice: string, tagHint: string): string {
  return `刚才 ${comment.senderName} 在群里发了${mediaNounFor(comment.kind)}。${forwardNotice}内容是：「${comment.description}」（聊天记录里对应「${tagHint}」那行）。请以你的人设，针对这份内容本身发表一两句评价/吐槽/调侃——自然一点，不要机械复述描述，也不要提"描述"两个字。第一条消息请把 reply_to_trigger 设为 true，让评价以「回复」形式挂在那条消息上；评不出花来，简短一句也行，或者至少给那条消息扣个表情反应。`;
}

/** 排队补跑的回复任务；description 来自 queuedTriggerDescription。 */
export function queuedTriggerInstruction(description: string): string {
  return `刚才你忙着回别的消息的时候，${description}，这条是排队等到现在才轮到处理的。请针对这条消息、以你的人设自然接住话题，建议第一条消息把 reply_to_trigger 设为 true 挂在那条消息上，让对方知道你在回哪条；如果你后来的发言其实已经回应过这条、或者话题早就翻篇了，且没有新内容，就直接结束，不要换个说法再答一次，也不要为补回应额外发言或扣反应。${SILENT_REPLY_END_INSTRUCTION}`;
}

/** 只读参考记忆区块里的自我身份声明：转录中哪个发言人、哪个编号是机器人自己。 */
export function selfIdentityStatement(selfId: number, username: string): string {
  return `本群中 [id:${selfId}] 的发言人「${SELF_SPEAKER_NAME}」就是你。` +
    `你的 Telegram 用户名是 @${username}。` +
    `转录里编号写作「${SELF_ROSTER_CODE}」的行就是你自己之前说过的话（行内不会再出现这个 id）；` +
    "回复这个发言人的消息，指向的对象也是你。";
}
