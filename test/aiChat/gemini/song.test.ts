/**
 * Gemini 生歌适配器：Interactions API 的请求映射与响应载荷门禁。
 *
 * 这条与其余四条流水线的关键差别都要守住：走 `interactions.create` 而不是
 * generateContent，因此每次调用必须自带加长超时与「不重试」的显式次数——SDK 的
 * next-gen 客户端不继承构造期的 retryOptions，而一次生成就是一笔按首计的账单。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import { SONG_GENERATION_MAX_BYTES } from "../../../packages/consts/aiChat/songGeneration";
import type { GeneratedChatSong } from "../../../packages/types/aiChat/songGeneration";

const create = mock(async (..._args: unknown[]): Promise<unknown> => ({}));
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/gemini/client", () => ({
  getGeminiClient: (_capability: string): unknown => ({ interactions: { create } }),
}));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { generateGeminiSong } = await import("../../../packages/aiChat/gemini/song");
const {
  GEMINI_SONG_REQUEST_ATTEMPTS,
  GEMINI_SONG_REQUEST_TIMEOUT_MS,
} = await import("../../../packages/consts/aiChat/gemini");

/** 一段合法的 base64 音频载荷。 */
const AUDIO_BYTES: Uint8Array = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1, 2, 3]);

function audioInteraction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    output_audio: { type: "audio", data: AUDIO_BYTES.toBase64(), mime_type: "audio/mp3" },
    // Lyria 会一并回歌词；本项目刻意不采，用例里保留它正是为了断言这一点。
    output_text: "第一段歌词",
    ...overrides,
  };
}

beforeEach(() => {
  create.mockClear();
  loggerError.mockClear();
  create.mockResolvedValue(audioInteraction());
});

describe("Gemini 生歌适配器", () => {
  test("提示词作为纯文本 input，模型名取自部署配置", async () => {
    const song: GeneratedChatSong | null = await generateGeminiSong({ prompt: "a lo-fi ballad" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toEqual({
      model: getAgentDeploymentConfig().song?.model,
      input: "a lo-fi ballad",
    });
    expect(song?.mimeType).toBe("audio/mp3");
    expect(song?.bytes).toEqual(AUDIO_BYTES);
    // 歌词不进结果：群里只发这首歌本身，采回来存着不用就是一份没有消费方的状态。
    expect(Object.keys(song ?? {}).sort()).toEqual(["bytes", "mimeType"]);
  });

  test("每次调用显式带加长超时与不重试；SDK 的客户端默认值对这条端点不适用", async () => {
    await generateGeminiSong({ prompt: "p" });

    const options = create.mock.calls[0]![1] as { timeout: number; maxRetries: number; signal: AbortSignal };
    expect(options.timeout).toBe(GEMINI_SONG_REQUEST_TIMEOUT_MS);
    expect(options.maxRetries).toBe(GEMINI_SONG_REQUEST_ATTEMPTS - 1);
    // 一次生成就是一次计费，重试只是再买一次同样的失败。
    expect(GEMINI_SONG_REQUEST_ATTEMPTS).toBe(1);
  });

  test("超时预算必须由本包合成成 signal——SDK 一见到 signal 就跳过自己那份 timeout", async () => {
    // 没有调用方 signal 时也要带一个：否则这条端点上的请求可以无限期挂住，
    // 占着整轮的心跳与工具轮次。
    await generateGeminiSong({ prompt: "p" });
    const withoutCaller = (create.mock.calls[0]![1] as { signal?: AbortSignal }).signal;
    expect(withoutCaller).toBeInstanceOf(AbortSignal);

    // 有调用方 signal 时合成，两条都能中止这次请求。
    create.mockClear();
    const controller: AbortController = new AbortController();
    await generateGeminiSong({ prompt: "p", signal: controller.signal });
    const combined = (create.mock.calls[0]![1] as { signal?: AbortSignal }).signal;
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined).not.toBe(controller.signal);
    expect(combined?.aborted).toBe(false);
    controller.abort();
    expect(combined?.aborted).toBe(true);
  });

  test("本轮作废立即结束等待且不记日志", async () => {
    const controller: AbortController = new AbortController();
    let settleSdkTask!: (value: unknown) => void;
    const sdkTask: Promise<unknown> = new Promise<unknown>((
      resolve: (value: unknown) => void
    ): void => {
      settleSdkTask = resolve;
    });
    create.mockImplementationOnce((): Promise<unknown> => sdkTask);
    const pendingResult: ReturnType<typeof generateGeminiSong> = generateGeminiSong({
      prompt: "p",
      signal: controller.signal,
    });
    controller.abort();

    await expect(pendingResult).resolves.toBeNull();
    expect(loggerError).not.toHaveBeenCalled();
    settleSdkTask(audioInteraction());
    await sdkTask;
  });

  test("调用前已作废时不调用生歌端点", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();

    await expect(generateGeminiSong({ prompt: "p", signal: controller.signal }))
      .resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("超时中止仍要记日志：那次生成已经在服务端出过账", async () => {
    // 调用方没有 abort，因此这次失败必须留下痕迹，不能被当成「本轮作废」吞掉。
    const controller: AbortController = new AbortController();
    create.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(generateGeminiSong({ prompt: "p", signal: controller.signal })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini song generation API:", expect.any(DOMException));
  });

  test("请求抛错时归一成一次普通失败并记一行英文日志", async () => {
    create.mockRejectedValueOnce(new Error("boom"));

    await expect(generateGeminiSong({ prompt: "p" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini song generation API:", expect.any(Error));
  });

  test("HTTP 成功却没有音频要点名，否则与「模型没产出」不可区分", async () => {
    create.mockResolvedValueOnce({ output_text: "只有歌词" });

    await expect(generateGeminiSong({ prompt: "p" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Gemini song generation API returned no audio payload.");
  });

  test("载荷不合格时带原因记日志：脏 base64、超限、缺 mime", async () => {
    create.mockResolvedValueOnce(audioInteraction({
      output_audio: { type: "audio", data: "not base64!!", mime_type: "audio/mp3" },
    }));
    await expect(generateGeminiSong({ prompt: "p" })).resolves.toBeNull();

    create.mockResolvedValueOnce(audioInteraction({
      output_audio: {
        type: "audio",
        data: new Uint8Array(SONG_GENERATION_MAX_BYTES + 1).toBase64(),
        mime_type: "audio/mp3",
      },
    }));
    await expect(generateGeminiSong({ prompt: "p" })).resolves.toBeNull();

    create.mockResolvedValueOnce(audioInteraction({
      output_audio: { type: "audio", data: AUDIO_BYTES.toBase64() },
    }));
    await expect(generateGeminiSong({ prompt: "p" })).resolves.toBeNull();

    const reasons: string[] = loggerError.mock.calls.map((call: unknown[]): string => String(call[0]));
    expect(reasons[0]).toContain("payload is not canonical base64");
    expect(reasons[1]).toContain("exceeds the size limit");
    expect(reasons[2]).toContain("missing audio mime type");
  });

  test("有没有 output_text 都不影响结果：判的只是音频在不在", async () => {
    create.mockResolvedValueOnce(audioInteraction({ output_text: "" }));

    const song: GeneratedChatSong | null = await generateGeminiSong({ prompt: "instrumental only" });
    expect(song).not.toBeNull();
    expect(loggerError).not.toHaveBeenCalled();
  });
});
