/**
 * Anthropic 的纯文本生成、结构化 JSON 与视觉描述请求映射：系统提示词进 system，内容进单条 user
 * 消息，模型按能力取自部署配置，不带温度；JSON 按 output_config.format 约束。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";

const requestAnthropicTextResult = mock(async (..._args: unknown[]): Promise<AiTextResult> => ({ ok: true, text: "ok" }));
mock.module("../../../packages/aiChat/anthropic/client", () => ({ requestAnthropicTextResult }));

const { describeAnthropicVision, generateAnthropicJson, generateAnthropicText } = await import("../../../packages/aiChat/anthropic/text");
const {
  ANTHROPIC_CHAT_SUMMARY_MAX_TOKENS,
  ANTHROPIC_JSON_MAX_TOKENS,
  ANTHROPIC_MEDIA_DESCRIPTION_MAX_TOKENS,
  ANTHROPIC_STICKER_PACK_SUMMARY_MAX_TOKENS,
} = await import("../../../packages/consts/aiChat/anthropic");

interface CapturedOptions {
  readonly capability: string;
  readonly buildBody: () => Anthropic.MessageCreateParamsNonStreaming;
  readonly normalize: (text: string) => string;
}

function captured(): CapturedOptions {
  return requestAnthropicTextResult.mock.calls.at(-1)![0] as CapturedOptions;
}

beforeEach(() => requestAnthropicTextResult.mockClear());

describe("Anthropic 文本类请求", () => {
  test("摘要按 summary 能力，两条流水线各用自己的输出上限", async () => {
    const normalize = (text: string): string => text;
    await generateAnthropicText({ purpose: "chatSummary", systemPrompt: "压缩", userContent: "对话", errorLabel: "e", normalize });
    expect(captured().capability).toBe("summary");
    expect(captured().normalize).toBe(normalize);
    expect(captured().buildBody() as unknown).toEqual({
      model: getAgentDeploymentConfig().summary.model,
      system: "压缩",
      messages: [{ role: "user", content: "对话" }],
      max_tokens: ANTHROPIC_CHAT_SUMMARY_MAX_TOKENS,
    });
    await generateAnthropicText({ purpose: "stickerPackSummary", systemPrompt: "简介", userContent: "包", errorLabel: "e", normalize });
    expect(captured().buildBody().max_tokens).toBe(ANTHROPIC_STICKER_PACK_SUMMARY_MAX_TOKENS);
  });

  test("结构化 JSON 按 text 能力，Schema 交给 output_config.format", async () => {
    const schema: Readonly<Record<string, unknown>> = { type: "object", properties: {}, additionalProperties: false };
    await generateAnthropicJson({ systemPrompt: "只输出 JSON", userContent: "资料", jsonSchema: schema, errorLabel: "e" });
    expect(captured().buildBody().output_config?.format?.schema).toBe(schema);
    expect(captured().capability).toBe("text");
    expect(captured().buildBody() as unknown).toEqual({
      model: getAgentDeploymentConfig().text.model,
      system: "只输出 JSON",
      messages: [{ role: "user", content: "资料" }],
      output_config: { format: { type: "json_schema", schema } },
      max_tokens: ANTHROPIC_JSON_MAX_TOKENS,
    });
    expect(captured().normalize("  {}\n")).toBe("{}");
  });

  test("视觉描述按 media 能力，图片以 base64 内联", async () => {
    const bytes: Uint8Array = new Uint8Array([1, 2, 3]);
    await describeAnthropicVision({ prompt: "描述", image: { bytes, mime: "image/png" }, errorLabel: "e", normalize: (text: string): string => text });
    expect(captured().capability).toBe("media");
    expect(captured().buildBody() as unknown).toEqual({
      model: getAgentDeploymentConfig().media.model,
      system: "描述",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toBase64() } }] }],
      max_tokens: ANTHROPIC_MEDIA_DESCRIPTION_MAX_TOKENS,
    });
  });
});
