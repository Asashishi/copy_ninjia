/**
 * OpenAI 生图适配器：gpt-image-2 任意尺寸、GPT Image 通用标准尺寸与 xAI
 * aspect_ratio 三档显式分流，最终共用同一份载荷安全门禁。
 *
 * 画幅收敛只发生在实现包内部——领域侧仍按十档表达意图，这份测试同时守住
 * 「换回 Gemini 不必改任何调用点」这个前提。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentDeploymentConfig,
  OpenAiImageProtocol,
} from "../../../packages/types/config";

const generate = mock(async (..._args: unknown[]): Promise<unknown> => ({ data: [{ b64_json: "" }] }));
const edit = mock(async (..._args: unknown[]): Promise<unknown> => ({ data: [{ b64_json: "" }] }));
const post = mock(async (..._args: unknown[]): Promise<unknown> => ({ data: [{ b64_json: "" }] }));
const loggerError = mock((..._args: unknown[]): void => {});
const IMAGE_MODEL: string = "configured-image-model";
let imageProtocol: OpenAiImageProtocol = "openai";

mock.module("../../../packages/aiChat/openai/client", () => ({
  getOpenAiClient: (_capability: string) => ({ images: { generate, edit }, post }),
}));
mock.module("../../../packages/config/agent", () => ({
  getAgentDeploymentConfig: (): AgentDeploymentConfig => ({
    text: { provider: "openai", apiKey: "text-key", baseUrl: undefined, model: "r" },
    summary: { provider: "openai", apiKey: "summary-key", baseUrl: undefined, model: "s" },
    media: { provider: "openai", apiKey: "media-key", baseUrl: undefined, model: "m" },
    image: { provider: "openai", apiKey: "image-key", baseUrl: undefined, model: IMAGE_MODEL, imageProtocol },
  }),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const { generateOpenAiImage } = await import("../../../packages/aiChat/openai/image");
const {
  OPENAI_IMAGE_MODERATION,
  OPENAI_IMAGE_OUTPUT_FORMAT,
  OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  XAI_IMAGE_RESOLUTION,
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
  post.mockClear();
  loggerError.mockClear();
  imageProtocol = "openai";
});

describe("OpenAI 官方 gpt-image-2 画幅", () => {
  test("十档逐档发送两边可被 16 整除的尺寸，不再收敛到旧三档", async () => {
    for (const [aspectRatio, expectedSize] of [
      ["1:1", "1024x1024"],
      ["3:2", "1536x1024"],
      ["2:3", "1024x1536"],
      ["4:3", "1408x1056"],
      ["3:4", "1056x1408"],
      ["5:4", "1360x1088"],
      ["4:5", "1088x1360"],
      ["16:9", "1536x864"],
      ["9:16", "864x1536"],
      ["21:9", "1568x672"],
    ] as const) {
      respondWith(PNG.toString("base64"));
      await generateOpenAiImage({ prompt: "p", aspectRatio });
      expect((generate.mock.calls.at(-1)![0] as { size: string }).size).toBe(expectedSize);
    }
  });
});

describe("OpenAI 官方 GPT Image 通用画幅", () => {
  test("openai-standard 只发送全系共同支持的三种标准尺寸", async () => {
    imageProtocol = "openai-standard";
    for (const [aspectRatio, expectedSize] of [
      ["1:1", "1024x1024"],
      ["5:4", "1536x1024"],
      ["21:9", "1536x1024"],
      ["4:5", "1024x1536"],
      ["9:16", "1024x1536"],
    ] as const) {
      respondWith(PNG.toString("base64"));
      await generateOpenAiImage({ prompt: "p", aspectRatio });
      expect((generate.mock.calls.at(-1)![0] as { size: string }).size).toBe(expectedSize);
    }
  });

  test("标准尺寸档的参考图仍走 SDK 原生 edit", async () => {
    imageProtocol = "openai-standard";
    edit.mockResolvedValueOnce({ data: [{ b64_json: PNG.toString("base64") }] });

    await generateOpenAiImage({
      prompt: "改成水彩",
      aspectRatio: "9:16",
      referenceImage: { bytes: JPEG, mime: "image/jpeg" },
    });

    expect(generate).not.toHaveBeenCalled();
    expect((edit.mock.calls[0]![0] as { size: string }).size).toBe("1024x1536");
  });
});

describe("请求分流", () => {
  test("无参考图走 images.generate，并使用独立的生图超时", async () => {
    respondWith(PNG.toString("base64"));
    await generateOpenAiImage({ prompt: "一只纸飞机", aspectRatio: "16:9" });

    expect(edit).not.toHaveBeenCalled();
    expect(generate.mock.calls[0]![0]).toEqual({
      model: IMAGE_MODEL,
      prompt: "一只纸飞机",
      size: "1536x864",
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
    expect(body.model).toBe(IMAGE_MODEL);
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

describe("api.x.ai 的 Grok Imagine 兼容请求", () => {
  test("生成请求改传 xAI aspect_ratio 与 base64 信封，不夹带 OpenAI 专属尺寸和档位", async () => {
    imageProtocol = "xai";
    respondWith(JPEG.toString("base64"));

    await generateOpenAiImage({ prompt: "超宽海报", aspectRatio: "21:9" });

    expect(edit).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(generate.mock.calls[0]![0]).toEqual({
      model: IMAGE_MODEL,
      prompt: "超宽海报",
      aspect_ratio: "20:9",
      resolution: XAI_IMAGE_RESOLUTION,
      response_format: "b64_json",
      n: 1,
    });
    expect(generate.mock.calls[0]![1]).toEqual({
      signal: undefined,
      timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
    });
  });

  test("xAI 不支持的近方形比例映射到最近官方比例，其余领域比例原样发送", async () => {
    imageProtocol = "xai";
    for (const [requested, expected] of [
      ["5:4", "4:3"],
      ["4:5", "3:4"],
      ["16:9", "16:9"],
    ] as const) {
      respondWith(PNG.toString("base64"));
      await generateOpenAiImage({ prompt: "p", aspectRatio: requested });
      expect((generate.mock.calls.at(-1)![0] as { aspect_ratio: string }).aspect_ratio).toBe(expected);
    }
  });

  test("参考图改走同一 SDK 客户端的 JSON post，并且只产生协议要求的 base64 字符串", async () => {
    imageProtocol = "xai";
    post.mockResolvedValueOnce({ data: [{ b64_json: JPEG.toString("base64") }] });

    await generateOpenAiImage({
      prompt: "改成铅笔画",
      aspectRatio: "16:9",
      referenceImage: { bytes: JPEG, mime: "image/jpeg" },
    });

    expect(generate).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(post.mock.calls[0]![0]).toBe("/images/edits");
    expect(post.mock.calls[0]![1]).toEqual({
      body: {
        model: IMAGE_MODEL,
        prompt: "改成铅笔画",
        image: { type: "image_url", url: `data:image/jpeg;base64,${JPEG.toString("base64")}` },
        resolution: XAI_IMAGE_RESOLUTION,
        response_format: "b64_json",
      },
      signal: undefined,
      timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
    });
  });

  test("参考图空响应的日志不把未发送的领域画幅说成实际 canvas", async () => {
    imageProtocol = "xai";
    post.mockResolvedValueOnce({ data: [] });

    await expect(generateOpenAiImage({
      prompt: "改成铅笔画",
      aspectRatio: "16:9",
      referenceImage: { bytes: JPEG, mime: "image/jpeg" },
    })).resolves.toBeNull();

    expect((post.mock.calls[0]![1] as { body: { aspect_ratio?: string } }).body.aspect_ratio)
      .toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("canvas=follows-reference"));
    expect(loggerError).not.toHaveBeenCalledWith(expect.stringContaining("canvas=16:9"));
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
    // agent.image.model 是自由文本、解析器只校验非空：填成非 gpt-image 模型，
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
  test("调用前已取消时不调用任何生图端点", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();

    await expect(generateOpenAiImage({
      prompt: "p",
      aspectRatio: "1:1",
      signal: controller.signal,
    })).resolves.toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("请求抛错时记一行日志并返回 null", async () => {
    generate.mockRejectedValueOnce(new Error("boom"));
    await expect(generateOpenAiImage({ prompt: "p", aspectRatio: "1:1" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling OpenAI image generation API:", expect.any(Error));
  });

  test("调用方主动取消时静默返回 null，不记错误日志", async () => {
    const controller: AbortController = new AbortController();
    let settleSdkTask!: (value: unknown) => void;
    const sdkTask: Promise<unknown> = new Promise<unknown>((
      resolve: (value: unknown) => void
    ): void => {
      settleSdkTask = resolve;
    });
    generate.mockImplementationOnce((): Promise<unknown> => sdkTask);
    const pendingResult: ReturnType<typeof generateOpenAiImage> = generateOpenAiImage({
      prompt: "p",
      aspectRatio: "1:1",
      signal: controller.signal,
    });
    controller.abort();

    await expect(pendingResult).resolves.toBeNull();
    expect(loggerError).not.toHaveBeenCalled();
    settleSdkTask({ data: [{ b64_json: PNG.toString("base64") }] });
    await sdkTask;
  });
});
