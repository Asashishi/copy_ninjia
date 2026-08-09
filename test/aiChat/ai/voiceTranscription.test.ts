/**
 * 群聊语音转写：下载适配层的容器归一与上限，以及「当前供应商没有这项能力」时的
 * 降级口径。
 *
 * 最要守住的一条是**不换供应商**：转写不可用时留兜底占位，绝不为了识别一条语音
 * 临时切到另一家（见 aiChat/provider.ts 的模块头注）。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";
import type { TelegramWorkerDownloadFileResult } from "../../../packages/types/telegramWorker";

const downloadTelegramFileFromMain = mock(async (..._args: unknown[]): Promise<TelegramWorkerDownloadFileResult> => ({
  status: "ok" as const,
  bytes: new Uint8Array([1, 2, 3]),
}));
const transcribeVoice = mock(async (..._args: unknown[]): Promise<AiTextResult> => ({
  ok: true,
  text: "今天下班一起吃饭吗",
}));
const loggerError = mock((..._args: unknown[]): void => {});
const mediaAiProvider = mock((): unknown => ({ name: "google", transcribeVoice }));

mock.module("../../../packages/infra/telegram/workerClient", () => ({
  downloadTelegramFileFromMain,
}));
const realProvider = await import("../../../packages/aiChat/provider");
// 只替换 mediaAiProvider 这一个导出：同模块的 imageAiProvider 仍被生图工具静态
// 引用，整份替换会让那条 import 在求值期就断掉。
mock.module("../../../packages/aiChat/provider", () => ({ ...realProvider, mediaAiProvider }));
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const { transcribeVoiceUncached } = await import("../../../packages/aiChat/ai/voiceTranscription");
const { normalizeVoiceMime } = await import("../../../packages/aiChat/ai/telegramAudio");
const {
  VOICE_MAX_DOWNLOAD_BYTES,
  VOICE_TRANSCRIPT_MAX_CHARS,
} = await import("../../../packages/consts/aiChat/voice");

/** 默认参数：一条 12 秒的 OGG voice note。 */
function voiceParams(overrides: Partial<{ fileId: string; declaredMime: string | undefined; durationSeconds: number }> = {}): {
  fileId: string;
  declaredMime: string | undefined;
  durationSeconds: number;
} {
  return { fileId: "voice-file", declaredMime: "audio/ogg", durationSeconds: 12, ...overrides };
}

beforeEach(() => {
  for (const mocked of [downloadTelegramFileFromMain, transcribeVoice, loggerError, mediaAiProvider]) {
    mocked.mockClear();
  }
  downloadTelegramFileFromMain.mockImplementation(async (): Promise<TelegramWorkerDownloadFileResult> => ({
    status: "ok" as const,
    bytes: new Uint8Array([1, 2, 3]),
  }));
  transcribeVoice.mockImplementation(async (): Promise<AiTextResult> => ({ ok: true, text: "今天下班一起吃饭吗" }));
  mediaAiProvider.mockImplementation((): unknown => ({ name: "google", transcribeVoice }));
});

describe("Telegram 语音容器归一", () => {
  test("白名单内的声明原样保留，大小写与空白被归一", () => {
    expect(normalizeVoiceMime("audio/ogg")).toBe("audio/ogg");
    expect(normalizeVoiceMime(" AUDIO/MP3 ")).toBe("audio/mp3");
  });

  test("缺失或白名单外的声明一律退回 OGG，不把外部输入原样转发进请求体", () => {
    expect(normalizeVoiceMime(undefined)).toBe("audio/ogg");
    expect(normalizeVoiceMime("audio/x-weird")).toBe("audio/ogg");
    expect(normalizeVoiceMime("application/json")).toBe("audio/ogg");
  });
});

describe("语音转写", () => {
  test("音频字节与归一后的容器一起交给供应商的语音接口", async () => {
    await expect(transcribeVoiceUncached(voiceParams())).resolves.toEqual({ ok: true, text: "今天下班一起吃饭吗" });

    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    const request = transcribeVoice.mock.calls[0]![0] as {
      prompt: string;
      clip: { mime: string; durationSeconds: number; bytes: Buffer };
      errorLabel: string;
    };
    expect(request.clip.mime).toBe("audio/ogg");
    expect(request.clip.durationSeconds).toBe(12);
    expect(Buffer.from(request.clip.bytes).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(request.errorLabel).toBe("AI voice transcription API");
    // 指令必须要原话而不是概括：这一行会被当成群友说过的话读。
    expect(request.prompt).toContain("逐字");
  });

  test("转写向主线程声明 voice 下载能力，不允许 Worker 自报任意字节上限", async () => {
    await transcribeVoiceUncached(voiceParams());
    expect(downloadTelegramFileFromMain).toHaveBeenCalledWith({
      fileId: "voice-file",
      purpose: "voice",
      signal: undefined,
    });
  });

  test("清洗压成单行并按语音自己的上限收在子句边界", async () => {
    transcribeVoice.mockImplementationOnce(async (..._args: unknown[]): Promise<AiTextResult> => ({ ok: true, text: "  多行\n转写  " }));
    await transcribeVoiceUncached(voiceParams());
    const normalize = (transcribeVoice.mock.calls[0]![0] as { normalize: (text: string) => string }).normalize;

    expect(normalize("  多行\n转写  ")).toBe("多行 转写");
    expect(normalize("")).toBe("");
    expect(normalize("啊".repeat(VOICE_TRANSCRIPT_MAX_CHARS + 50)).length).toBeLessThanOrEqual(VOICE_TRANSCRIPT_MAX_CHARS);
  });

  test("供应商没有这项能力时点名记一行，并且不可重采样——再试仍是同一家", async () => {
    mediaAiProvider.mockImplementationOnce((): unknown => ({ name: "openai" }));

    await expect(transcribeVoiceUncached(voiceParams())).resolves.toEqual({
      ok: false,
      retryable: false,
      mediaFailure: "unsupported",
    });
    expect(loggerError).toHaveBeenCalledWith(
      "Voice transcription is unavailable: the openai media provider does not implement it."
    );
  });

  test("下载失败按可重采样的失败返回，且不发模型请求", async () => {
    downloadTelegramFileFromMain.mockResolvedValueOnce({ status: "missingPath" });
    await expect(transcribeVoiceUncached(voiceParams())).resolves.toEqual({ ok: false, retryable: true });

    downloadTelegramFileFromMain.mockResolvedValueOnce({ status: "httpError", httpStatus: 404 });
    await expect(transcribeVoiceUncached(voiceParams())).resolves.toEqual({ ok: false, retryable: true });

    downloadTelegramFileFromMain.mockResolvedValueOnce({
      status: "tooLarge",
      observedBytes: VOICE_MAX_DOWNLOAD_BYTES + 1,
    });
    await expect(transcribeVoiceUncached(voiceParams())).resolves.toEqual({ ok: false, retryable: true });

    // 空下载同样拦在模型请求之前：0 字节的 inlineData 只会换来一次必然失败的请求。
    downloadTelegramFileFromMain.mockResolvedValueOnce({ status: "empty" });
    await expect(transcribeVoiceUncached(voiceParams())).resolves.toEqual({ ok: false, retryable: true });

    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(4);
  });

  test("下载抛错不上抛，归一成不可重采样的失败", async () => {
    downloadTelegramFileFromMain.mockRejectedValueOnce(new Error("getFile failed"));
    await expect(transcribeVoiceUncached(voiceParams())).resolves.toEqual({ ok: false, retryable: true });
    expect(loggerError).toHaveBeenCalledWith("Error loading chat voice:", expect.any(Error));
  });
});
