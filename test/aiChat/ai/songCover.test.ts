/**
 * 生歌消息的封面缩略图。
 *
 * Lyria 只产出音频与歌词（模型卡的 Supported outputs 就是 "Audio (MP3),
 * Text (Lyrics)"），响应里没有任何图像；群里那些带专辑封面的音乐消息，封面来自
 * 源文件里嵌的 ID3 APIC 帧——搬运真实曲目才有。想让播放条上不是一个通用音符
 * 图标，只能自己补一张。
 *
 * 这里要守住的三条：封面画幅固定正方形、提示词禁止出现文字、任何一步失败都
 * 静默交回 null（歌才是这次调用的主体，绝不能为一张装帧图把它整条丢掉）。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GeneratedChatImage } from "../../../packages/types/aiChat/imageGeneration";

const generateChatImage = mock(async (..._args: unknown[]): Promise<GeneratedChatImage | null> => ({
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mimeType: "image/png",
}));
const prepareThumbnailJpeg = mock(async (..._args: unknown[]): Promise<Buffer | null> =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const loggerError = mock((..._args: unknown[]): void => {});
const realImage = await import("../../../packages/infra/image");

mock.module("../../../packages/aiChat/ai/imageGeneration", () => ({ generateChatImage }));
mock.module("../../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));
mock.module("../../../packages/infra/image", () => ({ ...realImage, prepareThumbnailJpeg }));

const { generateSongCover } = await import("../../../packages/aiChat/ai/songCover");
const {
  SONG_COVER_JPEG_QUALITIES,
  SONG_COVER_MAX_BYTES,
  SONG_COVER_MAX_EDGE,
} = await import("../../../packages/consts/aiChat/songGeneration");

function coverParams(signal?: AbortSignal): {
  title: string;
  performer: string;
  songPrompt: string;
  signal?: AbortSignal;
} {
  return {
    title: "夏天的尾巴",
    performer: "小忍",
    songPrompt: "a warm lo-fi ballad, 80 BPM, Chinese vocals",
    ...(signal ? { signal } : {}),
  };
}

beforeEach(() => {
  generateChatImage.mockClear();
  prepareThumbnailJpeg.mockClear();
  loggerError.mockClear();
  generateChatImage.mockImplementation(async (): Promise<GeneratedChatImage | null> => ({
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png",
  }));
  prepareThumbnailJpeg.mockImplementation(async (): Promise<Buffer | null> =>
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
});

describe("生歌封面", () => {
  test("画幅固定正方形：封面本来是方的，缩略图还会被客户端再裁一次方", async () => {
    await generateSongCover(coverParams());

    const request = generateChatImage.mock.calls[0]![0] as { aspectRatio: string };
    expect(request.aspectRatio).toBe("1:1");
  });

  test("提示词把曲目信息当气氛线索，并明令整张图不许出现文字", async () => {
    await generateSongCover(coverParams());

    const prompt = (generateChatImage.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("夏天的尾巴");
    expect(prompt).toContain("小忍");
    expect(prompt).toContain("a warm lo-fi ballad, 80 BPM, Chinese vocals");
    // 生图模型写出来的中日文几乎必然是错的，而缩略图只有 320 像素见方。
    expect(prompt).toContain("不要出现任何文字");
    // 创作说明里的技术词不能被照着画进去。
    expect(prompt).toContain("不要照抄");
  });

  test("按 Bot API 的三项硬性要求压缩：JPEG、长边 320、体积上限", async () => {
    await generateSongCover(coverParams());

    expect(prepareThumbnailJpeg).toHaveBeenCalledTimes(1);
    expect(prepareThumbnailJpeg.mock.calls[0]![0]).toMatchObject({
      maxEdge: SONG_COVER_MAX_EDGE,
      maxBytes: SONG_COVER_MAX_BYTES,
      qualities: SONG_COVER_JPEG_QUALITIES,
    });
    expect(SONG_COVER_MAX_EDGE).toBe(320);
    // 「小于 200 kB」的单位与 multipart 开销文档都没写死，留出余量而不是卡边界。
    expect(SONG_COVER_MAX_BYTES).toBeLessThan(200 * 1024);
  });

  test("本轮的取消信号一路透传给生图请求", async () => {
    const controller: AbortController = new AbortController();
    await generateSongCover(coverParams(controller.signal));

    expect((generateChatImage.mock.calls[0]![0] as { signal?: AbortSignal }).signal)
      .toBe(controller.signal);
  });

  test("生图失败时不再压缩，直接交回 null", async () => {
    generateChatImage.mockImplementationOnce(async (): Promise<GeneratedChatImage | null> => null);

    await expect(generateSongCover(coverParams())).resolves.toBeNull();
    expect(prepareThumbnailJpeg).not.toHaveBeenCalled();
  });

  test("压不进体积上限时交回 null，绝不上传一张会被整条拒绝的缩略图", async () => {
    prepareThumbnailJpeg.mockImplementationOnce(async (): Promise<Buffer | null> => null);

    await expect(generateSongCover(coverParams())).resolves.toBeNull();
  });

  test("生图这一步**抛错**同样只交回 null，绝不让异常逃出去", async () => {
    // imageAiProvider() 在能力配置或端点异常时可能抛错。这个 reject 若逃出
    // generateSongCover，展开的不是这一次封面，而是 toolset.execute() 外面整个
    // 工具循环——歌已经生成、账已经出，群里却什么都收不到。
    generateChatImage.mockImplementationOnce(async (): Promise<GeneratedChatImage | null> => {
      throw new Error('Agent capability "image" is unavailable.');
    });

    await expect(generateSongCover(coverParams())).resolves.toBeNull();
    expect(prepareThumbnailJpeg).not.toHaveBeenCalled();
  });

  test("压缩这一步抛错也照样只交回 null", async () => {
    prepareThumbnailJpeg.mockImplementationOnce(async (): Promise<Buffer | null> => {
      throw new Error("sharp exploded");
    });

    await expect(generateSongCover(coverParams())).resolves.toBeNull();
  });

  test("本轮已作废时的失败不记日志——那不是故障", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();
    generateChatImage.mockImplementationOnce(async (): Promise<GeneratedChatImage | null> => {
      throw new Error("aborted");
    });

    await expect(generateSongCover(coverParams(controller.signal))).resolves.toBeNull();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("非作废原因的抛错要留下一行英文诊断", async () => {
    generateChatImage.mockImplementationOnce(async (): Promise<GeneratedChatImage | null> => {
      throw new Error("boom");
    });

    await generateSongCover(coverParams());
    expect(loggerError).toHaveBeenCalledWith("Error generating a song cover:", expect.any(Error));
  });

  test("字节按引用交给压缩，不为一张几 MB 的生图白复制一份", async () => {
    const bytes: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    generateChatImage.mockImplementationOnce(async (): Promise<GeneratedChatImage | null> => ({
      bytes,
      mimeType: "image/png",
    }));

    await generateSongCover(coverParams());
    expect((prepareThumbnailJpeg.mock.calls[0]![0] as { bytes: Uint8Array }).bytes).toBe(bytes);
  });
});
