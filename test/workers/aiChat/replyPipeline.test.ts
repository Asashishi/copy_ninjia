import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdmitDecision } from "../../../src/types/states/replyAdmission";

let decision: AdmitDecision = { action: "startRound" };
const admitTrigger = mock((_input: unknown): AdmitDecision => decision);
const startReplyRound = mock((_input: unknown, _drain: (chatId: number) => void): void => {});
const pushReplyTrigger = mock((_input: unknown): void => {});
const drainQueuedReplies = mock((_chatId: number, _start: (trigger: unknown) => void): void => {});
const loggerError = mock((_message: string): void => {});
const pendingOverflowNotices = new Set<number>();

mock.module("../../../src/cache/aiChat/identity", () => ({
  botInfoState: { current: { id: 1, username: "copy_ninjia_bot", first_name: "Ninjia" } },
}));
mock.module("../../../src/cache/aiChat/replies", () => ({
  activeReplyCounts: new Map<number, number>(),
  pendingOverflowNotices,
  pendingReplyTriggers: new Map<number, { size: number }>(),
}));
mock.module("../../../src/infra/logger", () => ({
  logger: { error: loggerError },
}));
mock.module("../../../src/states/replyAdmission", () => ({ admitTrigger }));
mock.module("../../../src/workers/aiChat/replyQueue", () => ({
  drainReplyQueue: drainQueuedReplies,
  pushReplyTrigger,
  triggerKindFor: (random: boolean, media: unknown): string => media ? "mediaDirect" : random ? "random" : "direct",
}));
mock.module("../../../src/workers/aiChat/replyRound", () => ({ startReplyRound }));
mock.module("../../../src/workers/aiChat/replyState", () => ({
  currentReplyGeneration: (): number => 17,
  invalidateChatReplies: (): void => {},
  isReplyGenerationCurrent: (): boolean => true,
}));

const { generateAndSendReply } = await import("../../../src/workers/aiChat/replyPipeline");

const baseRequest = {
  chatId: -1001,
  triggerSenderId: 42,
  replyToMessageId: 7,
  imageGenerationRequested: false,
  isRandomTrigger: false,
};

beforeEach(() => {
  decision = { action: "startRound" };
  pendingOverflowNotices.clear();
  for (const fn of [admitTrigger, startReplyRound, pushReplyTrigger, drainQueuedReplies, loggerError]) fn.mockClear();
});

describe("AI reply admission pipeline", () => {
  test("立即执行时携带当前 generation，并把轮结束回调接回排队器", () => {
    generateAndSendReply(baseRequest);

    expect(startReplyRound).toHaveBeenCalledWith(
      expect.objectContaining({ ...baseRequest, generation: 17 }),
      expect.any(Function)
    );
    const drain = startReplyRound.mock.calls[0]![1];
    drain(-1001);
    expect(drainQueuedReplies).toHaveBeenCalledWith(-1001, expect.any(Function));
  });

  test("排队、溢出和静默丢弃分别只执行自己的副作用", () => {
    decision = { action: "enqueue" };
    generateAndSendReply({ ...baseRequest, imageGenerationRequested: true });
    expect(pushReplyTrigger).toHaveBeenCalledWith(expect.objectContaining({ chatId: -1001 }));

    decision = { action: "enqueueOverflow" };
    generateAndSendReply(baseRequest);
    expect(pendingOverflowNotices.has(-1001)).toBeTrue();

    decision = { action: "dropSilently" };
    generateAndSendReply(baseRequest);
    expect(startReplyRound).not.toHaveBeenCalled();
    expect(pushReplyTrigger).toHaveBeenCalledTimes(1);
  });
});
