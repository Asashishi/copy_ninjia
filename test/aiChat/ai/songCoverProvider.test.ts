import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GeneratedChatImage } from "../../../packages/types/aiChat/imageGeneration";
import type { AgentDeploymentConfig } from "../../../packages/types/config";

const googleGenerateImage = mock(async (..._args: unknown[]): Promise<GeneratedChatImage | null> => ({
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mimeType: "image/png",
}));
const openAiGenerateImage = mock(async (..._args: unknown[]): Promise<GeneratedChatImage | null> => ({
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  mimeType: "image/jpeg",
}));
const prepareThumbnailJpeg = mock(async (..._args: unknown[]): Promise<Buffer | null> =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const realImage = await import("../../../packages/libs/image");

let agentConfig: AgentDeploymentConfig;
mock.module("../../../packages/config/agent", () => ({
  getAgentDeploymentConfig: (): AgentDeploymentConfig => agentConfig,
}));
mock.module("../../../packages/aiChat/gemini", () => ({
  geminiProvider: { name: "google", generateImage: googleGenerateImage },
}));
mock.module("../../../packages/aiChat/openai", () => ({
  openAiProvider: { name: "openai", generateImage: openAiGenerateImage },
}));
mock.module("../../../packages/libs/image", () => ({ ...realImage, prepareThumbnailJpeg }));

const { generateSongCover } = await import("../../../packages/aiChat/ai/songCover");
const { resetAiProviderSchedulerCache } =
  await import("../../../packages/cache/workers/aiChat/providerScheduler");

const COVER_PARAMS = {
  title: "夏天的尾巴",
  performer: "小忍",
  songPrompt: "a warm lo-fi ballad",
} as const;

beforeEach((): void => {
  resetAiProviderSchedulerCache();
  agentConfig = {
    text: { provider: "google", apiKey: "google-text-key", baseUrl: undefined, model: "text" },
    summary: { provider: "google", apiKey: "google-summary-key", baseUrl: undefined, model: "summary" },
    media: { provider: "google", apiKey: "google-media-key", baseUrl: undefined, model: "media" },
    image: { provider: "google", apiKey: "google-image-key", baseUrl: undefined, model: "image", imageProtocol: undefined },
  };
  googleGenerateImage.mockClear();
  openAiGenerateImage.mockClear();
  prepareThumbnailJpeg.mockClear();
});

describe("生歌封面跟随 image 能力配置", () => {
  test("Google image 配置走 Google", async () => {
    await generateSongCover({ ...COVER_PARAMS });
    expect(googleGenerateImage).toHaveBeenCalledTimes(1);
    expect(openAiGenerateImage).not.toHaveBeenCalled();
  });

  test("OpenAI image 配置独立切到 OpenAI", async () => {
    agentConfig = {
      ...agentConfig,
      image: {
        provider: "openai",
        apiKey: "xai-image-key",
        baseUrl: "https://xai.example/v1",
        model: "grok-image",
        imageProtocol: "xai",
      },
    };
    await generateSongCover({ ...COVER_PARAMS });
    expect(openAiGenerateImage).toHaveBeenCalledTimes(1);
    expect(googleGenerateImage).not.toHaveBeenCalled();
    expect(prepareThumbnailJpeg).toHaveBeenCalledTimes(1);
    const passed: Uint8Array = (prepareThumbnailJpeg.mock.calls[0]![0] as { bytes: Uint8Array }).bytes;
    expect([...passed]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });
});
