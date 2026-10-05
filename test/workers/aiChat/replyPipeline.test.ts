import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AdmitDecision } from "../../../packages/types/states/replyAdmission";
import { TimestampDeque } from "../../../packages/libs/timestampDeque";
import { RATE_LIMIT_LONG_MAX_TRIGGERS } from "../../../packages/consts/aiChat/rateLimit";

let decision: AdmitDecision = "startRound";
const admitTrigger = mock((_input: unknown): AdmitDecision => decision);
let roundRateLimited: boolean = false;
const isReplyRoundRateLimited = mock((_windowCount: number): boolean => roundRateLimited);
const startReplyRound = mock((_input: unknown, _drain: (chatId: number) => void, _modelFinished: (chatId: number) => void): boolean => true);
const pushReplyTrigger = mock((_input: unknown): void => {});
const drainQueuedReplies = mock((_chatId: number, _start: (trigger: unknown) => void): void => {});
const flushOverflowNotice = mock((chatId: number): void => { pendingOverflowNotices.delete(chatId); });
const loggerError = mock((_message: string): void => {});
const pendingOverflowNotices = new Map<number, number | undefined>();
const pendingReplyTriggers = new Map<number, { size: number }>();
const longTriggerTimes = new Map<number, TimestampDeque>();
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
const hasReplyDeliveryCapacity = mock((_chatId: number): boolean => true);
const isDirectReplyModelActive = mock((_chatId: number): boolean => false);
const hasLiveReplyRounds = mock((_chatId: number): boolean => true);
mock.module("../../../packages/workers/aiChat/replyDelivery", () => ({ hasLiveReplyRounds, hasReplyDeliveryCapacity, isDirectReplyModelActive }));

mock.module("../../../packages/cache/workers/aiChat/identity", () => ({ botInfoState }));
mock.module("../../../packages/cache/workers/aiChat/replies", () => ({
  activeReplyCounts: new Map<number, number>(),
  cachedReplyGeneration: (): number => 17,
  longTriggerTimes,
  pendingOverflowNotices,
  pendingReplyTriggers,
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError }),
}));
mock.module("../../../packages/states/replyAdmission", () => ({ admitTrigger, isReplyRoundRateLimited }));
mock.module("../../../packages/workers/aiChat/replyQueue", () => ({
  drainReplyQueue: drainQueuedReplies,
  flushOverflowNotice,
  pushReplyTrigger,
  triggerKindFor: (random: boolean, media: unknown): string => media ? "mediaDirect" : random ? "random" : "direct",
}));
mock.module("../../../packages/workers/aiChat/replyRound", () => ({ startReplyRound }));
mock.module("../../../packages/workers/aiChat/bufferedMessageIndex", () => ({ replyReferenceForBufferedMessage }));

const { drainPendingReplyQueues, generateAndSendReply } = await import("../../../packages/workers/aiChat/replyPipeline");

const baseRequest = {
  chatId: -1001,
  triggerSenderId: 42,
  replyToMessageId: 7,
  messageThreadId: undefined,
  imageGenerationRequested: false,
  isRandomTrigger: false,
};

beforeEach(() => {
  decision = "startRound";
  roundRateLimited = false;
  botInfoState.current = botInfo;
  pendingOverflowNotices.clear();
  pendingReplyTriggers.clear();
  longTriggerTimes.clear();
  hasReplyDeliveryCapacity.mockReset().mockReturnValue(true);
  isDirectReplyModelActive.mockReset().mockReturnValue(false);
  hasLiveReplyRounds.mockReset().mockReturnValue(true);
  startReplyRound.mockReset().mockReturnValue(true);
  for (const fn of [
    admitTrigger,
    startReplyRound,
    pushReplyTrigger,
    drainQueuedReplies,
    flushOverflowNotice,
    isReplyRoundRateLimited,
    loggerError,
    replyReferenceForBufferedMessage,
  ]) fn.mockClear();
});

describe("AI reply admission pipeline", () => {
  test("准入携带发送容量，容量不足的直接触发按排队决策处理", () => {
    hasReplyDeliveryCapacity.mockReturnValue(false);
    decision = "enqueue";
    generateAndSendReply(baseRequest);
    expect(admitTrigger).toHaveBeenCalledWith(expect.objectContaining({ deliveryAvailable: false }));
    expect(pushReplyTrigger).toHaveBeenCalledTimes(1);
    expect(pushReplyTrigger).toHaveBeenCalledWith(expect.objectContaining({ replyToMessageId: 7 }));
    expect(startReplyRound).not.toHaveBeenCalled();
  });

  test("准入携带本群直接轮是否仍在模型阶段", () => {
    isDirectReplyModelActive.mockReturnValue(true);
    decision = "dropSilently";
    generateAndSendReply(baseRequest);
    expect(isDirectReplyModelActive).toHaveBeenCalledWith(baseRequest.chatId);
    expect(admitTrigger).toHaveBeenCalledWith(expect.objectContaining({ directRoundActive: true }));
  });

  test("模型完成只补跑待处理队列，溢出提示留到发送收尾且仍遵守窗口限频", () => {
    generateAndSendReply(baseRequest);
    pendingOverflowNotices.set(-1001, 17);
    const onModelFinished = startReplyRound.mock.calls[0]![2];
    onModelFinished(-1001);
    expect(drainQueuedReplies).toHaveBeenCalledTimes(1);
    expect(flushOverflowNotice).not.toHaveBeenCalled();
    expect(pendingOverflowNotices.get(-1001)).toBe(17);
    const times = new TimestampDeque(RATE_LIMIT_LONG_MAX_TRIGGERS);
    times.push(Date.now());
    longTriggerTimes.set(-1001, times);
    roundRateLimited = true;
    onModelFinished(-1001);
    expect(drainQueuedReplies).toHaveBeenCalledTimes(1);
    startReplyRound.mock.calls[0]![1](-1001);
    expect(flushOverflowNotice).toHaveBeenCalledTimes(1);
    expect(pendingOverflowNotices.has(-1001)).toBe(false);
  });

  test("立即执行时携带当前 generation，并把轮结束回调接回排队器", () => {
    generateAndSendReply(baseRequest);

    expect(startReplyRound).toHaveBeenCalledWith(
      expect.objectContaining({ ...baseRequest, triggerReference, generation: 17 }),
      expect.any(Function),
      expect.any(Function)
    );
    expect(replyReferenceForBufferedMessage).toHaveBeenCalledWith(-1001, 7);
    const drain = startReplyRound.mock.calls[0]![1];
    pendingReplyTriggers.set(-1001, { size: 1 });
    drain(-1001);
    expect(drainQueuedReplies).toHaveBeenCalledWith(-1001, expect.any(Function));
  });

  test("排队、溢出和静默丢弃分别只执行自己的副作用", () => {
    decision = "enqueue";
    generateAndSendReply({ ...baseRequest, imageGenerationRequested: true });
    expect(pushReplyTrigger).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      triggerReference,
    }));

    decision = "enqueueOverflow";
    generateAndSendReply(baseRequest);
    expect(pendingOverflowNotices.has(-1001)).toBeTrue();
    expect(flushOverflowNotice).not.toHaveBeenCalled();

    decision = "dropSilently";
    generateAndSendReply(baseRequest);
    expect(startReplyRound).not.toHaveBeenCalled();
    expect(pushReplyTrigger).toHaveBeenCalledTimes(1);
  });

  test("溢出时群里没有存活轮次就当场发出提示，不等永远不会到来的收尾推力", () => {
    decision = "enqueueOverflow";
    hasLiveReplyRounds.mockReturnValue(false);
    // 发出时读到的话题必须是这条被丢掉的触发所在的话题。
    let flushedTopic: number | undefined;
    flushOverflowNotice.mockImplementationOnce((chatId: number): void => {
      flushedTopic = pendingOverflowNotices.get(chatId);
      pendingOverflowNotices.delete(chatId);
    });
    generateAndSendReply({ ...baseRequest, messageThreadId: 42 });
    expect(flushOverflowNotice).toHaveBeenCalledWith(-1001);
    expect(flushedTopic).toBe(42);
    expect(pendingOverflowNotices.has(-1001)).toBeFalse();
  });

  test("排空队列时按原样启动排队触发，并在该轮结束后继续排空同群队列", () => {
    generateAndSendReply(baseRequest);
    pendingReplyTriggers.set(-1001, { size: 1 });
    startReplyRound.mock.calls[0]![1](-1001);
    const startQueuedRound = drainQueuedReplies.mock.calls[0]![1];
    const queued = {
      triggerSenderId: 42,
      replyToMessageId: 7,
      messageThreadId: undefined,
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
      messageThreadId: undefined,
      imageGenerationRequested: true,
      imageGenerationReference: queued.imageGenerationReference,
      triggerReference,
      isRandomTrigger: false,
      queuedTrigger: queued,
    }, expect.any(Function), expect.any(Function));

    startReplyRound.mock.calls[1]![1](-1001);
    expect(drainQueuedReplies).toHaveBeenCalledTimes(2);
  });

  // 轮次参数的两个构造点（本文件的 startQueuedRound 与 generateAndSendReply 的
  // startRound 分支）必须产出同一个隐藏类：缺席的可选字段显式写 undefined，而不是
  // 条件展开成「不写这个键」。口径与 auto/message/recordContext.ts、
  // antiRaid/adCandidate.ts、workers/aiChat/bufferedMessage.ts 一致；那三处的注释
  // 记着同一件事——这种对象会被下游反复读，多种 shape 会让读点多态。
  // 键集合仍然逐字校验，误加或漏字段照样测得出来。
  test("轮次参数保持单一 shape：缺席的可选字段显式写成 undefined", () => {
    generateAndSendReply(baseRequest);
    pendingReplyTriggers.set(-1001, { size: 1 });
    startReplyRound.mock.calls[0]![1](-1001);
    const startQueuedRound = drainQueuedReplies.mock.calls[0]![1];

    startQueuedRound({
      triggerSenderId: 42,
      replyToMessageId: 7,
      messageThreadId: undefined,
      imageGenerationRequested: false,
      senderName: "Alice",
      text: "排队期间的触发原文",
    });

    const roundParams = startReplyRound.mock.calls[1]![0] as Record<string, unknown>;
    expect(roundParams.imageGenerationReference).toBeUndefined();
    expect(roundParams.triggerReference).toBeUndefined();
    expect(Object.keys(roundParams).sort()).toEqual([
      "chatId",
      "chatQa",
      "generation",
      "imageGenerationReference",
      "imageGenerationRequested",
      "isRandomTrigger",
      "mediaComment",
      "mediaPreparation",
      "messageThreadId",
      "queuedTrigger",
      "replyToMessageId",
      "triggerReference",
      "triggerSenderId",
    ]);
  });

  test("维护节拍在限频窗口空出来后补跑积压，窗口仍满时不空转", () => {
    // 队列的常规推力来自模型完成、轮次结束与新触发入队，而限频闸拒绝时那一轮根本没建
    // 任务、也就永远不会有完成回调：没有这道兜底，撞上长窗口上限的群会把最多
    // REPLY_TRIGGER_QUEUE_MAX 条 @提及连同快照无限期扣在内存里。
    pendingReplyTriggers.set(-1001, { size: 3 });
    const times: TimestampDeque = new TimestampDeque(RATE_LIMIT_LONG_MAX_TRIGGERS);
    times.push(900);
    longTriggerTimes.set(-1001, times);

    roundRateLimited = true;
    drainPendingReplyQueues(1_000);
    // 空转一次就等于每个 RATE_LIMIT_NOTICE_COOLDOWN_MS 冷却周期往群里刷一条限频提示。
    expect(drainQueuedReplies).not.toHaveBeenCalled();

    roundRateLimited = false;
    drainPendingReplyQueues(1_000);
    expect(drainQueuedReplies).toHaveBeenCalledWith(-1001, expect.any(Function));
  });

  test("维护节拍补跑后仍有积压的群移到末尾，排空或没补出的群保持原位，每群只推一次", () => {
    const queues = new Map<number, { size: number }>([
      [-1001, { size: 3 }],
      [-1002, { size: 3 }],
      [-1003, { size: 3 }],
    ]);
    for (const [chatId, queue] of queues) pendingReplyTriggers.set(chatId, queue);
    drainQueuedReplies.mockImplementation((chatId: number): void => {
      const queue: { size: number } = queues.get(chatId)!;
      // -1001 补出一条后仍有积压；-1002 一次排空；-1003 没拿到全局空位，一条没补出。
      if (chatId === -1001) queue.size--;
      if (chatId === -1002) queue.size = 0;
    });

    try {
      drainPendingReplyQueues(1_000);

      expect(drainQueuedReplies.mock.calls.map(([chatId]): number => chatId)).toEqual([-1001, -1002, -1003]);
      expect([...pendingReplyTriggers.keys()]).toEqual([-1002, -1003, -1001]);
    } finally {
      drainQueuedReplies.mockImplementation((): void => {});
    }
  });

  test("轮次结束的推力同样设闸：窗口仍满时只补溢出提示，不空转队列", () => {
    // 模型完成、轮次结束、新触发入队与维护节拍四处推力必须都过闸。轮次结束这一处不设闸的话，
    // 撞满长窗口且队列非空的群里每一轮结束都会空转一次 startReplyRound，被限频闸拒绝时
    // 它自己会发一条限频提示（自带 RATE_LIMIT_NOTICE_COOLDOWN_MS 冷却）——整个饱和期
    // 每个冷却周期往群里刷一句。
    pendingReplyTriggers.set(-1001, { size: 3 });
    const times: TimestampDeque = new TimestampDeque(RATE_LIMIT_LONG_MAX_TRIGGERS);
    times.push(900);
    longTriggerTimes.set(-1001, times);
    generateAndSendReply(baseRequest);
    const onFinished = startReplyRound.mock.calls[0]![1];
    drainQueuedReplies.mockClear();

    roundRateLimited = true;
    pendingOverflowNotices.set(-1001, undefined);
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
