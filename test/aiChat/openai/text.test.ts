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
import { getAiAgentOpenAiConfig } from "../../../packages/config/openai";

const requestOpenAiTextResult = mock(async (..._args: unknown[]): Promise<AiTextResult> => ({ ok: true, text: "ok" }));

mock.module("../../../packages/aiChat/openai/client", () => ({ requestOpenAiTextResult }));

const { describeOpenAiVision, generateOpenAiText } = await import("../../../packages/aiChat/openai/text");
const {
  OPENAI_CHAT_SUMMARY_MAX_TOKENS,
  OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS,
  OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS,
} = await import("../../../packages/consts/aiChat/openai");

type ResponseBody = OpenAI.Responses.ResponseCreateParamsNonStreaming;

/** 取本次调用交给底层的请求体构造器并就地求值：请求体改在 client.ts 的 try 内
 *  构造，好让 config/openai.json 的解析错误降级成一次普通失败而不是抛出。 */
function capturedBody(): ResponseBody {
  return (requestOpenAiTextResult.mock.calls[0]![0] as () => ResponseBody)();
}

beforeEach(() => {
  requestOpenAiTextResult.mockClear();
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
    expect(body.model).toBe(getAiAgentOpenAiConfig().models.summary);
    expect(body.instructions).toBe("把下面的对话压成一句话");
    expect(body.input).toBe("甲：你好\n乙：在");
    expect(body.max_output_tokens).toBe(OPENAI_CHAT_SUMMARY_MAX_TOKENS);
    expect(body.store).toBe(false);
    expect(requestOpenAiTextResult.mock.calls[0]![1]).toBe("AI summarize API");
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
    expect(requestOpenAiTextResult.mock.calls[0]![2]).toBe(normalize);
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
    expect(body.model).toBe(getAiAgentOpenAiConfig().models.media);
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
