import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdDetectJsonRequestParams } from "../../../packages/types/antiRaid/adDetect";
import type { AgentProvider } from "../../../packages/types/config";

let provider: AgentProvider = "google";
const requestGoogleAdDetectJson = mock(
  async (_params: AdDetectJsonRequestParams): Promise<string | null> => "google"
);
const requestOpenAiAdDetectJson = mock(
  async (_params: AdDetectJsonRequestParams): Promise<string | null> => "openai"
);

mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: () => ({ provider }),
}));
mock.module("../../../packages/antiRaid/ai/google", () => ({ requestGoogleAdDetectJson }));
mock.module("../../../packages/antiRaid/ai/openai", () => ({ requestOpenAiAdDetectJson }));

const { requestAdDetectJson } = await import("../../../packages/antiRaid/ai/provider");

const params: AdDetectJsonRequestParams = {
  model: "ad-model",
  systemPrompt: "只输出 JSON",
  userContent: "1. 在吗",
  temperature: 0.5,
  maxOutputTokens: 256,
  errorLabel: "Test ad request",
};

beforeEach((): void => {
  provider = "google";
  requestGoogleAdDetectJson.mockClear();
  requestOpenAiAdDetectJson.mockClear();
});

describe("广告检测 provider 分派", () => {
  test("Google 配置只调用 Google 传输并原样转发请求", async () => {
    await expect(requestAdDetectJson(params)).resolves.toBe("google");
    expect(requestGoogleAdDetectJson).toHaveBeenCalledWith(params);
    expect(requestOpenAiAdDetectJson).not.toHaveBeenCalled();
  });

  test("OpenAI 配置只调用 OpenAI 兼容传输", async () => {
    provider = "openai";

    await expect(requestAdDetectJson(params)).resolves.toBe("openai");
    expect(requestOpenAiAdDetectJson).toHaveBeenCalledWith(params);
    expect(requestGoogleAdDetectJson).not.toHaveBeenCalled();
  });
});
