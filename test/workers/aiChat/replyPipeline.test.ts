import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdmitDecision } from "../../../packages/types/states/replyAdmission";

let decision: AdmitDecision = { action: "startRound" };
const admitTrigger = mock((_input: unknown): AdmitDecision => decision);
const startReplyRound = mock((_input: unknown, _drain: (chatId: number) => void): void => {});
const pushReplyTrigger = mock((_input: unknown): void => {});
const drainQueuedReplies = mock((_chatId: number, _start: (trigger: unknown) => void): void => {});
const loggerError = mock((_message: string): void => {});
const pendingOverflowNotices = new Set<number>();
const triggerReference = {
  messageId: 7,
  id: 42,
  firstName: "Alice",
  lastName: "",
  text: "触发消息",
};
const replyReferenceForBufferedMessage = mock((_chatId: number, _messageId: number) => triggerReference);
const botInfo = { id: 1, username: "copy_ninjia_bot", first_name: "Ninjia" };
const botInfoState: { current: typeof botInfo | null } = { current: botInfo };

mock.module("../../../packages/cache/aiChat/identity", () => ({ botInfoState }));
mock.module("../../../packages/cache/aiChat/replies", () => ({
  activeReplyCounts: new Map<number, number>(),
  pendingOverflowNotices,
  pendingReplyTriggers: new Map<number, { size: number }>(),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: { error: loggerError },
}));
mock.module("../../../packages/states/replyAdmission", () => ({ admitTrigger }));
mock.module("../../../packages/workers/aiChat/replyQueue", () => ({
  drainReplyQueue: drainQueuedReplies,
  pushReplyTrigger,
  triggerKindFor: (random: boolean, media: unknown): string => media ? "mediaDirect" : random ? "random" : "direct",
}));
mock.module("../../../packages/workers/aiChat/replyRound", () => ({ startReplyRound }));
mock.module("../../../packages/workers/aiChat/replyChain", () => ({ replyReferenceForBufferedMessage }));
mock.module("../../../packages/workers/aiChat/replyState", () => ({
  currentReplyGeneration: (): number => 17,
  invalidateChatReplies: (): void => {},
  isReplyGenerationCurrent: (): boolean => true,
}));

const { generateAndSendReply } = await import("../../../packages/workers/aiChat/replyPipeline");

const baseRequest = {
  chatId: -1001,
  triggerSenderId: 42,
  replyToMessageId: 7,
  imageGenerationRequested: false,
  isRandomTrigger: false,
};

beforeEach(() => {
  decision = { action: "startRound" };
  botInfoState.current = botInfo;
  pendingOverflowNotices.clear();
  for (const fn of [
    admitTrigger,
    startReplyRound,
    pushReplyTrigger,
    drainQueuedReplies,
    loggerError,
    replyReferenceForBufferedMessage,
  ]) fn.mockClear();
});

describe("AI reply admission pipeline", () => {
  test("立即执行时携带当前 generation，并把轮结束回调接回排队器", () => {
    generateAndSendReply(baseRequest);

    expect(startReplyRound).toHaveBeenCalledWith(
      expect.objectContaining({ ...baseRequest, triggerReference, generation: 17 }),
      expect.any(Function)
    );
    expect(replyReferenceForBufferedMessage).toHaveBeenCalledWith(-1001, 7);
    const drain = startReplyRound.mock.calls[0]![1];
    drain(-1001);
    expect(drainQueuedReplies).toHaveBeenCalledWith(-1001, expect.any(Function));
  });

  test("排队、溢出和静默丢弃分别只执行自己的副作用", () => {
    decision = { action: "enqueue" };
    generateAndSendReply({ ...baseRequest, imageGenerationRequested: true });
    expect(pushReplyTrigger).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      triggerReference,
    }));

    decision = { action: "enqueueOverflow" };
    generateAndSendReply(baseRequest);
    expect(pendingOverflowNotices.has(-1001)).toBeTrue();

    decision = { action: "dropSilently" };
    generateAndSendReply(baseRequest);
    expect(startReplyRound).not.toHaveBeenCalled();
    expect(pushReplyTrigger).toHaveBeenCalledTimes(1);
  });

  test("排空队列时按原样启动排队触发，并在该轮结束后继续排空同群队列", () => {
    generateAndSendReply(baseRequest);
    startReplyRound.mock.calls[0]![1](-1001);
    const startQueuedRound = drainQueuedReplies.mock.calls[0]![1];
    const queued = {
      triggerSenderId: 42,
      replyToMessageId: 7,
      imageGenerationRequested: true,
      imageGenerationReference: { fileId: "f", fileUniqueId: "u", width: 512, height: 512 },
      triggerReference,
      senderName: "Alice",
      text: "排队期间的触发原文",
    };

    startQueuedRound(queued);

    // 排队轮一律不算随机触发，并把原触发对象带回给 replyRound 用于自录快照。
    expect(startReplyRound).toHaveBeenLastCalledWith({
      chatId: -1001,
      triggerSenderId: 42,
      replyToMessageId: 7,
      imageGenerationRequested: true,
      imageGenerationReference: queued.imageGenerationReference,
      triggerReference,
      isRandomTrigger: false,
      queuedTrigger: queued,
    }, expect.any(Function));

    startReplyRound.mock.calls[1]![1](-1001);
    expect(drainQueuedReplies).toHaveBeenCalledTimes(2);
  });

  test("缺少图片引用或触发快照时不塞空字段进轮次参数", () => {
    generateAndSendReply(baseRequest);
    startReplyRound.mock.calls[0]![1](-1001);
    const startQueuedRound = drainQueuedReplies.mock.calls[0]![1];

    startQueuedRound({
      triggerSenderId: 42,
      replyToMessageId: 7,
      imageGenerationRequested: false,
      senderName: "Alice",
      text: "排队期间的触发原文",
    });

    const roundParams = startReplyRound.mock.calls[1]![0] as Record<string, unknown>;
    expect("imageGenerationReference" in roundParams).toBeFalse();
    expect("triggerReference" in roundParams).toBeFalse();
  });

  test("身份尚未初始化时直接丢弃触发，不做任何准入判定", () => {
    botInfoState.current = null;

    generateAndSendReply(baseRequest);

    expect(admitTrigger).not.toHaveBeenCalled();
    expect(startReplyRound).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith("aiChatWorker received trigger before init message; dropping.");
  });
});
