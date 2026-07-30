import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdmitDecision, RoundDecision } from "../../../packages/types/states/replyAdmission";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";

let decision: AdmitDecision = { action: "startRound" };
const admitTrigger = mock((_input: unknown): AdmitDecision => decision);
let roundDecision: RoundDecision = { action: "run" };
const admitRound = mock((_input: unknown): RoundDecision => roundDecision);
const startReplyRound = mock((_input: unknown, _drain: (chatId: number) => void): void => {});
const pushReplyTrigger = mock((_input: unknown): void => {});
const drainQueuedReplies = mock((_chatId: number, _start: (trigger: unknown) => void): void => {});
const flushOverflowNotice = mock((chatId: number): void => { pendingOverflowNotices.delete(chatId); });
const loggerError = mock((_message: string): void => {});
const pendingOverflowNotices = new Set<number>();
const pendingReplyTriggers = new Map<number, { size: number }>();
const longTriggerTimes = new Map<number, LinkedQueue<number>>();
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

mock.module("../../../packages/cache/workers/aiChat/identity", () => ({ botInfoState }));
mock.module("../../../packages/cache/workers/aiChat/replies", () => ({
  activeReplyCounts: new Map<number, number>(),
  longTriggerTimes,
  pendingOverflowNotices,
  pendingReplyTriggers,
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: { error: loggerError },
}));
mock.module("../../../packages/states/replyAdmission", () => ({ admitTrigger, admitRound }));
mock.module("../../../packages/workers/aiChat/replyQueue", () => ({
  drainReplyQueue: drainQueuedReplies,
  flushOverflowNotice,
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

const { drainPendingReplyQueues, generateAndSendReply } = await import("../../../packages/workers/aiChat/replyPipeline");

const baseRequest = {
  chatId: -1001,
  triggerSenderId: 42,
  replyToMessageId: 7,
  imageGenerationRequested: false,
  isRandomTrigger: false,
};

beforeEach(() => {
  decision = { action: "startRound" };
  roundDecision = { action: "run" };
  botInfoState.current = botInfo;
  pendingOverflowNotices.clear();
  pendingReplyTriggers.clear();
  longTriggerTimes.clear();
  for (const fn of [
    admitTrigger,
    startReplyRound,
    pushReplyTrigger,
    drainQueuedReplies,
    flushOverflowNotice,
    admitRound,
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

  test("维护节拍在限频窗口空出来后补跑积压，窗口仍满时不空转", () => {
    // 队列的常规推力只有轮次结束的 onFinished，而限频闸拒绝时那一轮根本没建
    // 任务、也就永远不会有那次回调：没有这道兜底，撞上 5 分钟窗口上限的群会把
    // 最多 25 条 @提及连同快照无限期扣在内存里。
    pendingReplyTriggers.set(-1001, { size: 3 });
    const times: LinkedQueue<number> = new LinkedQueue<number>();
    times.push(900);
    longTriggerTimes.set(-1001, times);

    roundDecision = { action: "rateLimited" };
    drainPendingReplyQueues(1_000);
    // 空转一次就等于每分钟往群里刷一条限频提示（提示自带 60 秒冷却）。
    expect(drainQueuedReplies).not.toHaveBeenCalled();

    roundDecision = { action: "run" };
    drainPendingReplyQueues(1_000);
    expect(drainQueuedReplies).toHaveBeenCalledWith(-1001, expect.any(Function));
  });

  test("轮次结束的推力同样设闸：窗口仍满时只补溢出提示，不空转队列", () => {
    // 三处推力必须都过闸。轮次结束这一处不设闸的话，撞满 5 分钟窗口且队列非空的
    // 群里每一轮结束都会空转一次 startReplyRound，被限频闸拒绝时它自己会发一条
    // 限频提示（自带 60 秒冷却）——整个饱和期每分钟往群里刷一句。
    pendingReplyTriggers.set(-1001, { size: 3 });
    const times: LinkedQueue<number> = new LinkedQueue<number>();
    times.push(900);
    longTriggerTimes.set(-1001, times);
    generateAndSendReply(baseRequest);
    const onFinished = startReplyRound.mock.calls[0]![1];
    drainQueuedReplies.mockClear();

    roundDecision = { action: "rateLimited" };
    pendingOverflowNotices.add(-1001);
    onFinished(-1001);

    expect(drainQueuedReplies).not.toHaveBeenCalled();
    // 欠着群成员的那条溢出提示不跟着被跳过：它与推队列是两条独立的路径。
    expect(flushOverflowNotice).toHaveBeenCalledWith(-1001);
    expect(pendingOverflowNotices.has(-1001)).toBeFalse();
  });

  test("身份尚未初始化时直接丢弃触发，不做任何准入判定", () => {
    botInfoState.current = null;

    generateAndSendReply(baseRequest);

    expect(admitTrigger).not.toHaveBeenCalled();
    expect(startReplyRound).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith("aiChatWorker received trigger before init message; dropping.");
  });
});
