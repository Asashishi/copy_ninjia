import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GenerateContentResponse } from "@google/genai";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";

const responses: (GenerateContentResponse | null)[] = [];
const requestGeminiResponse = mock(async (..._args: unknown[]): Promise<GenerateContentResponse | null> =>
  responses.shift() ?? null
);
const sleep = mock(async (..._args: unknown[]): Promise<void> => {});
const logError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/ai/gemini", () => ({ requestGeminiResponse }));
mock.module("../../../packages/libs/sleep", () => ({ sleep }));
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: logError,
  },
}));
mock.module("../../../packages/workers/aiChat/timeSentence", () => ({
  currentTimeSentence: (): string => "当前实际时间：测试。",
}));

const { scheduleRotation } = await import("../../../packages/workers/aiChat/compaction");
const { botInfoState } = await import("../../../packages/cache/aiChat/identity");
const { compactionChains, compactionPendingCounts } = await import("../../../packages/cache/aiChat/compaction");
const { chatSummaries, dirtyMemoryChats, pendingSummaries } = await import("../../../packages/cache/aiChat/memory");
const { resetAiChatReplyCache } = await import("../../../packages/cache/aiChat/replies");
const { resetAiChatCompactionCache } = await import("../../../packages/cache/aiChat/compaction");
const { resetAiChatMemoryCache } = await import("../../../packages/cache/aiChat/memory");
const { COMPACTION_MAX_PENDING_PER_CHAT } = await import("../../../packages/consts/aiChat/memory");
const { invalidateChatReplies } = await import("../../../packages/workers/aiChat/replyGeneration");

const batch: BufferedMessage[] = [{
  messageId: 7,
  id: 7,
  firstName: "Alice",
  lastName: "",
  username: "alice",
  text: "今天继续测试压缩",
  at: "2026/07/19 12:00:00",
}];

function response(text: string): GenerateContentResponse {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  } as GenerateContentResponse;
}

async function waitForRotation(chatId: number): Promise<void> {
  const chain: Promise<void> | undefined = compactionChains.get(chatId);
  expect(chain).toBeDefined();
  await chain;
  await Promise.resolve();
}

beforeEach(() => {
  responses.length = 0;
  requestGeminiResponse.mockClear();
  sleep.mockClear();
  logError.mockClear();
  resetAiChatCompactionCache();
  resetAiChatMemoryCache();
  resetAiChatReplyCache();
  botInfoState.current = { id: 99, first_name: "Ninja", username: "ninja_bot" };
});

afterEach(() => {
  resetAiChatCompactionCache();
  resetAiChatMemoryCache();
  resetAiChatReplyCache();
  botInfoState.current = null;
});

describe("AI 中期记忆压缩", () => {
  test("同群轮换串行晋升上一轮摘要，并把新摘要留作待晋升项", async () => {
    responses.push(response(" 第一轮摘要\n仍是一行 "), response("第二轮摘要"));

    scheduleRotation(-1001, batch, false);
    await waitForRotation(-1001);
    expect(pendingSummaries.get(-1001)).toBe("第一轮摘要 仍是一行");
    expect(chatSummaries.has(-1001)).toBe(false);

    scheduleRotation(-1001, batch, true);
    await waitForRotation(-1001);
    expect(chatSummaries.get(-1001)?.last(5)).toEqual(["第一轮摘要 仍是一行"]);
    expect(pendingSummaries.get(-1001)).toBe("第二轮摘要");
    expect(dirtyMemoryChats.has(-1001)).toBe(true);
    expect(compactionPendingCounts.has(-1001)).toBe(false);
    expect(compactionChains.has(-1001)).toBe(false);
  });

  test("空响应按退避策略重试，成功后正常保存", async () => {
    responses.push(null, response("重试得到的摘要"));

    scheduleRotation(-1002, batch, false);
    await waitForRotation(-1002);

    expect(requestGeminiResponse).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(pendingSummaries.get(-1002)).toBe("重试得到的摘要");
  });

  test("请求在途时群代际失效会等待压缩 settle，迟到摘要不会污染新状态", async () => {
    let resolveRequest!: (value: GenerateContentResponse) => void;
    requestGeminiResponse.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    scheduleRotation(-1003, batch, false);
    const chain: Promise<void> | undefined = compactionChains.get(-1003);
    expect(chain).toBeDefined();
    await Promise.resolve();
    let invalidationSettled: boolean = false;
    const invalidated: Promise<void> = invalidateChatReplies(-1003).then((): void => {
      invalidationSettled = true;
    });
    await Promise.resolve();
    expect(invalidationSettled).toBe(false);
    resolveRequest(response("已经失效的摘要"));
    await chain;
    await invalidated;
    await Promise.resolve();

    expect(invalidationSettled).toBe(true);
    expect(pendingSummaries.has(-1003)).toBe(false);
    expect(dirtyMemoryChats.has(-1003)).toBe(false);
  });

  test("单群压缩积压达到硬顶时直接丢弃新任务", () => {
    compactionPendingCounts.set(-1004, COMPACTION_MAX_PENDING_PER_CHAT);

    scheduleRotation(-1004, batch, false);

    expect(requestGeminiResponse).not.toHaveBeenCalled();
    expect(compactionPendingCounts.get(-1004)).toBe(COMPACTION_MAX_PENDING_PER_CHAT);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
