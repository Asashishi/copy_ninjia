/**
 * OpenAI 的纯文本生成与视觉描述请求映射。
 *
 * 两条路径都必须显式带 instructions：不给系统提示词时，部分代理网关会把
 * 自己的默认提示词灌进去，产出的文风与长度全不受本项目控制——这份测试守的
 * 就是那一条。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type OpenAI from "openai";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";

const requestOpenAiTextResult = mock(async (..._args: unknown[]): Promise<AiTextResult> => ({ ok: true, text: "ok" }));
const createTranscription = mock(async (..._args: unknown[]): Promise<{ text: string }> => ({ text: "  你好\n世界  " }));
const getOpenAiClient = mock((): unknown => ({
  audio: { transcriptions: { create: createTranscription } },
}));

mock.module("../../../packages/aiChat/openai/client", () => ({
  getOpenAiClient,
  requestOpenAiTextResult,
}));

const {
  describeOpenAiVision,
  generateOpenAiText,
  transcribeOpenAiVoice,
} = await import("../../../packages/aiChat/openai/text");
const {
  OPENAI_CHAT_SUMMARY_MAX_TOKENS,
  OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS,
  OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS,
} = await import("../../../packages/consts/aiChat/openai");

type ResponseBody = OpenAI.Responses.ResponseCreateParamsNonStreaming;

/** 取本次调用交给底层的请求体构造器并就地求值：请求体改在 client.ts 的 try 内
 *  构造，好让 config/agent.json 的解析错误降级成一次普通失败而不是抛出。 */
function capturedBody(): ResponseBody {
  return (requestOpenAiTextResult.mock.calls[0]![0] as { buildBody: () => ResponseBody }).buildBody();
}

beforeEach(() => {
  requestOpenAiTextResult.mockClear();
  createTranscription.mockClear();
  getOpenAiClient.mockClear();
  createTranscription.mockImplementation(async (): Promise<{ text: string }> => ({ text: "  你好\n世界  " }));
});

describe("纯文本生成", () => {
  test("系统提示词进 instructions，待处理内容进 input", async () => {
    await generateOpenAiText({
      purpose: "chatSummary",
      systemPrompt: "把下面的对话压成一句话",
      userContent: "甲：你好\n乙：在",
      errorLabel: "AI summarize API",
      normalize: (text: string): string => text,
    });

    const body: ResponseBody = capturedBody();
    expect(body.model).toBe(getAgentDeploymentConfig().summary.model);
    expect(body.instructions).toBe("把下面的对话压成一句话");
    expect(body.input).toBe("甲：你好\n乙：在");
    expect(body.max_output_tokens).toBe(OPENAI_CHAT_SUMMARY_MAX_TOKENS);
    expect(body.store).toBe(false);
    expect((requestOpenAiTextResult.mock.calls[0]![0] as { errorLabel: string }).errorLabel).toBe("AI summarize API");
  });

  test("从不发送采样温度：摘要低温策略在 GPT-5 系推理模型上不可用", async () => {
    await generateOpenAiText({
      purpose: "chatSummary",
      systemPrompt: "s",
      userContent: "u",
      errorLabel: "label",
      normalize: (text: string): string => text,
    });
    const body: ResponseBody = capturedBody();
    expect(body.temperature).toBeUndefined();
  });

  test("贴纸整包简介走另一档 token 上限", async () => {
    await generateOpenAiText({
      purpose: "stickerPackSummary",
      systemPrompt: "s",
      userContent: "u",
      errorLabel: "label",
      normalize: (text: string): string => text,
    });
    const body: ResponseBody = capturedBody();
    expect(body.max_output_tokens).toBe(OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS);
  });

  test("清洗函数原样透传给底层，由领域侧决定截断口径", async () => {
    const normalize = (text: string): string => text.trim();
    await generateOpenAiText({
      purpose: "chatSummary",
      systemPrompt: "s",
      userContent: "u",
      errorLabel: "label",
      normalize,
    });
    expect((requestOpenAiTextResult.mock.calls[0]![0] as { normalize: unknown }).normalize).toBe(normalize);
  });
});

describe("视觉描述", () => {
  test("描述指令进 instructions，图片以 data URI 内联进 input", async () => {
    const bytes: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await describeOpenAiVision({
      prompt: "用一句中文描述这张贴纸",
      image: { bytes, mime: "image/png" },
      errorLabel: "AI image understanding API",
      normalize: (text: string): string => text,
    });

    const body: ResponseBody = capturedBody();
    expect(body.model).toBe(getAgentDeploymentConfig().media.model);
    expect(body.instructions).toBe("用一句中文描述这张贴纸");
    expect(body.input).toEqual([{
      role: "user",
      content: [{
        type: "input_image",
        image_url: `data:image/png;base64,${bytes.toString("base64")}`,
        detail: "auto",
      }],
    }]);
    expect(body.max_output_tokens).toBe(OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS);
    expect(body.store).toBe(false);
  });

  test("JPEG 走同一条路径，data URI 的 MIME 跟随实际字节格式", async () => {
    const bytes: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await describeOpenAiVision({
      prompt: "描述",
      image: { bytes, mime: "image/jpeg" },
      errorLabel: "label",
      normalize: (text: string): string => text,
    });

    const body: ResponseBody = capturedBody();
    const content = (body.input as { content: { image_url: string }[] }[])[0]!.content[0]!;
    expect(content.image_url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});

describe("语音转写", () => {
  test("首次真实请求把 OGG 文件交给 media 模型并清洗结果", async () => {
    const bytes: Buffer = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
    await expect(transcribeOpenAiVoice({
      prompt: "逐字转写",
      clip: { bytes, mime: "audio/ogg", durationSeconds: 3 },
      errorLabel: "AI voice transcription API",
      normalize: (text: string): string => text.trim().replaceAll("\n", " "),
    })).resolves.toEqual({ ok: true, text: "你好 世界" });

    expect(getOpenAiClient).toHaveBeenCalledWith("media");
    const body = createTranscription.mock.calls[0]?.[0] as {
      file: { name?: string; type?: string };
      model: string;
      prompt: string;
      response_format: string;
    };
    expect(body.model).toBe(getAgentDeploymentConfig().media.model);
    expect(body.prompt).toBe("逐字转写");
    expect(body.response_format).toBe("json");
    expect(body.file.name).toBe("voice.ogg");
    expect(body.file.type).toBe("audio/ogg");
  });
});
