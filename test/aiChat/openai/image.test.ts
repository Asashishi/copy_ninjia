/**
 * OpenAI 生图适配器：十档官方宽高比到 gpt-image 三种画幅的最近邻映射、
 * 参考图走 images.edit 的分流，以及载荷校验的安全门禁。
 *
 * 画幅收敛只发生在实现包内部——领域侧仍按十档表达意图，这份测试同时守住
 * 「换回 Gemini 不必改任何调用点」这个前提。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getAiAgentOpenAiConfig } from "../../../packages/config/openai";

const generate = mock(async (..._args: unknown[]): Promise<unknown> => ({ data: [{ b64_json: "" }] }));
const edit = mock(async (..._args: unknown[]): Promise<unknown> => ({ data: [{ b64_json: "" }] }));
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/openai/client", () => ({
  getOpenAiClient: () => ({ images: { generate, edit } }),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const { generateOpenAiImage } = await import("../../../packages/aiChat/openai/image");
const {
  OPENAI_IMAGE_MODERATION,
  OPENAI_IMAGE_OUTPUT_FORMAT,
  OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
} = await import("../../../packages/consts/aiChat/openai");
const { IMAGE_GENERATION_MAX_BYTES } = await import("../../../packages/consts/aiChat/imageGeneration");

const PNG: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function respondWith(encoded: string): void {
  generate.mockResolvedValueOnce({ data: [{ b64_json: encoded }] });
}

beforeEach(() => {
  generate.mockClear();
  edit.mockClear();
  loggerError.mockClear();
});

describe("宽高比到画幅的最近邻映射", () => {
  // 只有正方形本身落在方形画幅上：gpt-image 三档之间跨度很大，4:3 这类近方形
  // 按对数距离离 3:2 反而更近（log(1.5/1.333) < log(1.333/1.0)）。这是三档
  // 画幅的固有结果，不是映射写错——换回 Gemini 时十档会原样恢复。
  test("只有 1:1 落在方形画幅", async () => {
    respondWith(PNG.toString("base64"));
    await generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" });
    expect((generate.mock.calls.at(-1)![0] as { size: string }).size).toBe("1024x1024");
  });

  test("所有横向比例收敛到 1536x1024", async () => {
    for (const aspectRatio of ["3:2", "4:3", "5:4", "16:9", "21:9"] as const) {
      respondWith(PNG.toString("base64"));
      await generateOpenAiImage({ prompt: "p", aspectRatio });
      expect((generate.mock.calls.at(-1)![0] as { size: string }).size).toBe("1536x1024");
    }
  });

  test("所有竖向比例收敛到 1024x1536", async () => {
    for (const aspectRatio of ["2:3", "3:4", "4:5", "9:16"] as const) {
      respondWith(PNG.toString("base64"));
      await generateOpenAiImage({ prompt: "p", aspectRatio });
      expect((generate.mock.calls.at(-1)![0] as { size: string }).size).toBe("1024x1536");
    }
  });
});

describe("请求分流", () => {
  test("无参考图走 images.generate，并使用独立的生图超时", async () => {
    respondWith(PNG.toString("base64"));
    await generateOpenAiImage({ prompt: "一只纸飞机", aspectRatio: "16:9" });

    expect(edit).not.toHaveBeenCalled();
    expect(generate.mock.calls[0]![0]).toEqual({
      model: getAiAgentOpenAiConfig().models.image,
      prompt: "一只纸飞机",
      size: "1536x1024",
      // 不钉输出格式就由服务端默认值决定，一变成 WebP 就每次都在签名判定处落空。
      output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
      // 审核档位取 SDK 允许的最低档；edit 分支没有这个参数（见下一条用例）。
      moderation: OPENAI_IMAGE_MODERATION,
      n: 1,
    });
    expect(generate.mock.calls[0]![1]).toEqual({ signal: undefined, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS });
  });

  test("有参考图走 images.edit，并把字节转成可上传文件", async () => {
    edit.mockResolvedValueOnce({ data: [{ b64_json: PNG.toString("base64") }] });
    await generateOpenAiImage({
      prompt: "把原图改成水彩",
      aspectRatio: "1:1",
      referenceImage: { bytes: JPEG, mime: "image/jpeg" },
    });

    expect(generate).not.toHaveBeenCalled();
    const body = edit.mock.calls[0]![0] as {
      model: string;
      prompt: string;
      size: string;
      output_format: string;
      moderation?: unknown;
      n: number;
      image: { name?: string; type?: string };
    };
    expect(body.model).toBe(getAiAgentOpenAiConfig().models.image);
    expect(body.prompt).toBe("把原图改成水彩");
    expect(body.size).toBe("1024x1024");
    expect(body.output_format).toBe(OPENAI_IMAGE_OUTPUT_FORMAT);
    // 两条分支的审核档位不对称是**有意**的：openai@6.49 的 ImageEditParamsBase
    // 上根本没有 moderation，硬塞就是对未声明字段的猜测（见 image.ts 头注）。
    expect(body.moderation).toBeUndefined();
    expect(body.n).toBe(1);
    // 扩展名与 MIME 跟随实际字节格式，服务端据此判格式。
    expect(body.image.name).toBe("reference.jpg");
    expect(body.image.type).toBe("image/jpeg");
  });
});

describe("载荷校验", () => {
  test("按字节签名判定 MIME：PNG 与 JPEG 都接受", async () => {
    respondWith(PNG.toString("base64"));
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" }))
      .resolves.toEqual({ bytes: PNG, mimeType: "image/png" });

    respondWith(JPEG.toString("base64"));
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" }))
      .resolves.toEqual({ bytes: JPEG, mimeType: "image/jpeg" });
  });

  test("签名认不出 png/jpeg 时不做猜测性放行，且点名记下原因", async () => {
    respondWith(Buffer.from("RIFF????WEBP").toString("base64"));
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" })).resolves.toBeNull();
    // 静默返回 null 的话，图照样计费而日志里没有一行指向格式不匹配。
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("unusable image payload: byte signature matches neither PNG nor JPEG")
    );
  });

  test("拒绝非法 base64，并与格式不匹配分开记", async () => {
    respondWith("not-base64!");
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("unusable image payload: payload is not canonical base64")
    );
  });

  test("编码长度已证明解码后可能超限时不分配图片 Buffer，并如实记为超限", async () => {
    respondWith("A".repeat(Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4 + 4));
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("unusable image payload: encoded payload exceeds the size limit")
    );
  });

  test("响应里没有图片载荷时点名记录，返回 null", async () => {
    generate.mockResolvedValueOnce({ data: [] });
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("no usable image payload: no entries"));
  });

  test("只回 url 信封时与「模型没画出来」分开点名——那是配置问题不是模型问题", async () => {
    // ai_agent.models.image 是自由文本、解析器只校验非空：填成非 gpt-image 模型，
    // 或指向一个默认回 URL 信封的兼容网关，就是这个形状。日志只说「没有载荷」的
    // 话，运维手里那份配置看上去完全正常，图却每张都白计费。
    generate.mockResolvedValueOnce({ data: [{ url: "https://cdn.invalid/generated.png" }] });
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("no usable image payload: url envelope instead of base64")
    );
  });
});

describe("失败处理", () => {
  test("请求抛错时记一行日志并返回 null", async () => {
    generate.mockRejectedValueOnce(new Error("boom"));
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling OpenAI image generation API:", expect.any(Error));
  });

  test("调用方主动取消时静默返回 null，不记错误日志", async () => {
    const controller: AbortController = new AbortController();
    generate.mockImplementationOnce(async (): Promise<unknown> => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1", signal: controller.signal }))
      .resolves.toBeNull();
    expect(loggerError).not.toHaveBeenCalled();
  });
});
