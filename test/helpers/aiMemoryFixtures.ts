import type {
  BufferedMessage,
  BufferedReplyReference,
  ReplyChainLink,
} from "../../packages/types/aiChat/memory";
import type {
  AiRecordMediaMessage,
  AiRecordMessage,
  AiReplyReference,
} from "../../packages/types/aiChat/protocol";

/**
 * AI 记忆一族载荷的测试构造器。
 *
 * 这些类型的可选字段一律是 `T | undefined` 而不是 `?:`，因为生产侧靠「每个
 * 构造点都把字段写全」来保住隐藏类恒定（见 types/aiChat/speaker.ts）。那条
 * 约束对测试固件同样成立，但让每个用例都手写九个字段只会淹掉它真正想断言的
 * 那一两个，所以在这里集中给缺省值，用例只覆盖自己关心的字段。
 *
 * 缺省值刻意都取「没有」的那一档（undefined / 空串），与生产上最常见的一条
 * 普通文字消息一致；要测「有 username / 有回复 / 是转发」的分支就显式传。
 */

/** 一条逐字缓存消息；未指定的字段取「没有」。 */
export function bufferedMessageFixture(
  overrides: Partial<BufferedMessage> = {}
): BufferedMessage {
  return {
    messageId: 1,
    id: 100,
    firstName: "杂鱼",
    lastName: "",
    username: undefined,
    text: "消息正文",
    replyTo: undefined,
    forwardedFrom: undefined,
    at: "2026/08/02 11:45:00",
    ...overrides,
  };
}

/** 一条清洗后的回复引用快照。 */
export function bufferedReplyReferenceFixture(
  overrides: Partial<BufferedReplyReference> = {}
): BufferedReplyReference {
  return {
    messageId: 1,
    id: 100,
    firstName: "杂鱼",
    lastName: "",
    username: undefined,
    text: "被回复的正文",
    quote: undefined,
    forwardedFrom: undefined,
    ...overrides,
  };
}

/** 回复链上的一跳。 */
export function replyChainLinkFixture(
  overrides: Partial<ReplyChainLink> = {}
): ReplyChainLink {
  return { ...bufferedReplyReferenceFixture(), snapshotOnly: false, ...overrides };
}

/** 主线程投给 Worker 的原始回复引用（尚未清洗）。 */
export function aiReplyReferenceFixture(
  overrides: Partial<AiReplyReference> = {}
): AiReplyReference {
  return {
    messageId: 1,
    id: 100,
    firstName: "杂鱼",
    lastName: "",
    username: undefined,
    text: "被回复的正文",
    quote: undefined,
    forwardedFrom: undefined,
    ...overrides,
  };
}

/** 一条完整的媒体记录 Worker 载荷；缺省是一张无 caption、无触发的图片。 */
export function aiRecordMediaMessageFixture(
  overrides: Partial<AiRecordMediaMessage> = {}
): AiRecordMediaMessage {
  return {
    type: "recordMedia",
    chatId: -100_1,
    senderId: 100,
    firstName: "杂鱼",
    lastName: "",
    username: undefined,
    messageId: 1,
    replyTo: undefined,
    forwardedFrom: undefined,
    persistImmediately: false,
    kind: "photo",
    caption: "",
    fileId: "file",
    fileUniqueId: "unique",
    width: 640,
    height: 480,
    commentOnResolve: false,
    imageGenerationRequested: false,
    stickerFallbackText: undefined,
    directTrigger: undefined,
    ...overrides,
  };
}

/** 一条完整的文字记录 Worker 载荷。 */
export function aiRecordMessageFixture(
  overrides: Partial<AiRecordMessage> = {}
): AiRecordMessage {
  return {
    type: "record",
    chatId: -100_1,
    senderId: 100,
    firstName: "杂鱼",
    lastName: "",
    username: undefined,
    messageId: 1,
    replyTo: undefined,
    forwardedFrom: undefined,
    persistImmediately: false,
    text: "消息正文",
    ...overrides,
  };
}
