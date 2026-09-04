import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { bufferedMessageFixture } from "../../helpers/aiMemoryFixtures";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";

const responses: AiTextResult[] = [];
const generateText = mock(async (..._args: unknown[]): Promise<AiTextResult> =>
  responses.shift() ?? { ok: false, retryable: false }
);
const sleep = mock(async (..._args: unknown[]): Promise<void> => {});
const logError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/provider", () => ({
  summaryAiProvider: () => ({ name: "google", generateText }),
}));
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
const { botInfoState } = await import("../../../packages/cache/workers/aiChat/identity");
const { compactionChains, compactionPendingCounts } = await import("../../../packages/cache/workers/aiChat/compaction");
const { chatSummaries, dirtyMemoryChats, pendingSummaries } = await import("../../../packages/cache/workers/aiChat/memory");
const { replyAbortControllers, resetAiChatReplyCache } = await import("../../../packages/cache/workers/aiChat/replies");
const { resetAiChatCompactionCache } = await import("../../../packages/cache/workers/aiChat/compaction");
const { resetAiChatMemoryCache } = await import("../../../packages/cache/workers/aiChat/memory");
const { COMPACTION_MAX_PENDING_PER_CHAT } = await import("../../../packages/consts/aiChat/memory");
const { SUMMARY_SYSTEM_PROMPT } = await import("../../../packages/consts/aiChat/prompts/memory");
const { invalidateChatReplies } = await import("../../../packages/workers/aiChat/replyGeneration");

const batch: BufferedMessage[] = [bufferedMessageFixture({
  messageId: 7,
  id: 7,
  firstName: "Alice",
  lastName: "",
  username: "alice",
  text: "今天继续测试压缩",
  at: "2026/07/19 12:00:00",
})];

function response(text: string): AiTextResult {
  return { ok: true, text };
}

async function waitForRotation(chatId: number): Promise<void> {
  const chain: Promise<void> | undefined = compactionChains.get(chatId);
  expect(chain).toBeDefined();
  await chain;
  await Promise.resolve();
}

beforeEach(() => {
  responses.length = 0;
  generateText.mockClear();
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
  test("当前时间拼在 userContent 末尾，systemPrompt 逐字恒定", async () => {
    responses.push(response("摘要"));

    scheduleRotation(-1009, batch, false);
    await waitForRotation(-1009);

    const request: { systemPrompt: string; userContent: string } =
      generateText.mock.calls[0]?.[0] as { systemPrompt: string; userContent: string };
    // systemPrompt 是这次请求唯一可被隐式缓存的前缀段：掺进精确到秒的时间就会
    // 让它从第一个字节起每次都对不上（见 compaction.ts 的 summarizeBatch）。
    expect(request.systemPrompt).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(request.systemPrompt).not.toContain("当前实际时间");
    // 落在整批转录之后：那一段本来就每次都变，时间排在它后面不再多断一次前缀。
    expect(request.userContent.endsWith("当前实际时间：测试。")).toBe(true);
    expect(request.userContent.indexOf("当前实际时间")).toBeGreaterThan(
      request.userContent.indexOf("今天继续测试压缩")
    );
  });

  test("同群轮换串行晋升上一轮摘要，并把新摘要留作待晋升项", async () => {
    responses.push(response("第一轮摘要 仍是一行"), response("第二轮摘要"));

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

  test("成功请求中的空响应按退避策略重采样，随后正常保存", async () => {
    responses.push({ ok: false, retryable: true }, response("重试得到的摘要"));

    scheduleRotation(-1002, batch, false);
    await waitForRotation(-1002);

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(15_000, expect.any(AbortSignal));
    expect(pendingSummaries.get(-1002)).toBe("重试得到的摘要");
  });

  test("SDK 已耗尽请求重试时不再套业务层重试", async () => {
    responses.push({ ok: false, retryable: false }, response("不应被调用"));

    scheduleRotation(-1005, batch, false);
    await waitForRotation(-1005);

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(pendingSummaries.has(-1005)).toBe(false);
  });

  test("请求在途时群代际失效会等待压缩 settle，迟到摘要不会污染新状态", async () => {
    let resolveRequest!: (value: AiTextResult) => void;
    generateText.mockImplementationOnce(() => new Promise((resolve) => {
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

  test("单群压缩积压达到硬顶时直接丢弃新任务，且拒绝路径不留下任何登记", () => {
    compactionPendingCounts.set(-1004, COMPACTION_MAX_PENDING_PER_CHAT);
    const controllersBefore: number = replyAbortControllers.size;

    scheduleRotation(-1004, batch, false);

    expect(generateText).not.toHaveBeenCalled();
    expect(compactionPendingCounts.get(-1004)).toBe(COMPACTION_MAX_PENDING_PER_CHAT);
    expect(logError).toHaveBeenCalledTimes(1);
    // 拒绝路径不得惰性建出 AbortController：登记项只由 trackReplyGenerationTask
    // 的 finally（需要已跟踪任务）或整代失效清理摘除，这里没有任何一方会来收，
    // 持续溢出且长期不被作废的群会一路累积用不上的 controller。
    expect(replyAbortControllers.size).toBe(controllersBefore);
  });
});
