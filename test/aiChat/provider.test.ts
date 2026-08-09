import { beforeEach, expect, mock, test } from "bun:test";
import type { AgentDeploymentConfig } from "../../packages/types/config";

let agentConfig: AgentDeploymentConfig;
mock.module("../../packages/config/agent", () => ({
  getAgentDeploymentConfig: (): AgentDeploymentConfig => agentConfig,
}));
const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));

const {
  imageAiProvider,
  mediaAiProvider,
  reportUnimplementedAgentCapabilities,
  songAiProvider,
  summaryAiProvider,
  textAiProvider,
} = await import("../../packages/aiChat/provider");
const { geminiProvider } = await import("../../packages/aiChat/gemini");
const { openAiProvider } = await import("../../packages/aiChat/openai");
const { aiProviderQuotaLanes, resetAiProviderSchedulerCache } =
  await import("../../packages/cache/workers/aiChat/providerScheduler");

beforeEach((): void => {
  resetAiProviderSchedulerCache();
  agentConfig = {
    text: { provider: "google", apiKey: "google-text-key", baseUrl: undefined, model: "gemini-text" },
    summary: { provider: "openai", apiKey: "openai-summary-key", baseUrl: "https://openai.example/v1", model: "gpt-summary" },
    media: { provider: "google", apiKey: "google-media-key", baseUrl: "https://google.example", model: "gemini-media" },
    image: {
      provider: "openai",
      apiKey: "xai-image-key",
      baseUrl: "https://xai.example/v1",
      model: "grok-image",
      imageProtocol: "xai",
    },
    song: { provider: "google", apiKey: "google-song-key", baseUrl: undefined, model: "lyria" },
  };
  loggerError.mockClear();
});

test("每项能力按 agent 配置独立选择 provider", () => {
  expect(textAiProvider().name).toBe("google");
  expect(summaryAiProvider().name).toBe("openai");
  expect(mediaAiProvider().name).toBe("google");
  expect(imageAiProvider()?.name).toBe("openai");
  expect(songAiProvider()?.name).toBe("google");
});

test("修改一项只影响该能力", () => {
  agentConfig = {
    ...agentConfig,
    media: { provider: "openai", apiKey: "openai-media-key", baseUrl: undefined, model: "vision-model" },
  };
  expect(mediaAiProvider().name).toBe("openai");
  expect(textAiProvider().name).toBe("google");
  expect(summaryAiProvider().name).toBe("openai");
});

test("song 缺省时明确不提供生歌实现", () => {
  const { song: _song, ...withoutSong } = agentConfig;
  agentConfig = withoutSong;
  expect(songAiProvider()).toBeNull();
});

test("image 缺省时明确不提供生图实现", () => {
  const { image: _image, ...withoutImage } = agentConfig;
  agentConfig = withoutImage;
  expect(imageAiProvider()).toBeNull();
});

test("两家实现都装配齐五项能力", () => {
  for (const provider of [geminiProvider, openAiProvider] as const) {
    expect(typeof provider.createReplySession).toBe("function");
    expect(typeof provider.generateText).toBe("function");
    expect(typeof provider.describeVision).toBe("function");
    expect(typeof provider.generateImage).toBe("function");
  }
});

test("每项路由只暴露自己那一项能力", () => {
  // 门面只构造一次：热路径复用同一对象，同时把每次真实模型调用纳入配额闸门。
  expect(textAiProvider()).not.toBe(geminiProvider);
  expect(summaryAiProvider()).not.toBe(openAiProvider);
  expect(textAiProvider()).toBe(textAiProvider());
  expect(summaryAiProvider()).toBe(summaryAiProvider());
  expect(typeof textAiProvider().createReplySession).toBe("function");
  expect(typeof summaryAiProvider().generateText).toBe("function");
  expect(typeof mediaAiProvider().describeVision).toBe("function");
  expect(typeof imageAiProvider()?.generateImage).toBe("function");
});

test("相同协议、端点和凭据的不同能力共享一个配额闸门", () => {
  agentConfig = {
    ...agentConfig,
    text: { provider: "openai", apiKey: "shared-key", baseUrl: "https://shared.example/v1", model: "chat" },
    summary: { provider: "openai", apiKey: "shared-key", baseUrl: "https://shared.example/v1", model: "summary" },
  };

  textAiProvider();
  summaryAiProvider();

  expect(aiProviderQuotaLanes).toHaveLength(1);
});

/**
 * 跨能力调用必须在**编译期**就不成立。
 *
 * 断言写在不会被调用的闭包里：只要类型收窄失效，`@ts-expect-error` 就会变成
 * 「未使用的抑制」而让 typecheck 失败——这一条不靠运行期覆盖率保证。
 */
test("配了但这一家没实现的可选能力，只在启动时记一次诊断", () => {
  // song 选了没有生歌实现的那一家：结构校验会过、工具静默不挂，只有这行诊断
  // 能让部署者知道该改 $.agent.song 的 provider。
  agentConfig = {
    ...agentConfig,
    song: { provider: "openai", apiKey: "openai-song-key", baseUrl: undefined, model: "song-model" },
  };
  reportUnimplementedAgentCapabilities();
  expect(loggerError).toHaveBeenCalledTimes(1);
  const diagnostic: string = String(loggerError.mock.calls[0]![0]);
  expect(diagnostic).toContain("$.agent.song");
  expect(diagnostic).toContain("generate_song");
  // 诊断不回显凭据。
  expect(diagnostic).not.toContain("openai-song-key");
});

test("两家都实现的能力不刷诊断", () => {
  reportUnimplementedAgentCapabilities();
  expect(loggerError).not.toHaveBeenCalled();
});

test("跨能力调用无法通过类型检查", () => {
  const assertCrossCapabilityCallsRejected = (): void => {
    // 用完即弃的本地收集器，只为让每条断言成为一条语句；闭包从不执行。
    const rejected: unknown[] = [];
    // @ts-expect-error summary 路由只能生成摘要，不能拿去读图。
    rejected.push(summaryAiProvider().describeVision);
    // @ts-expect-error media 路由不能开回复会话。
    rejected.push(mediaAiProvider().createReplySession);
    // @ts-expect-error text 路由不能生成纯文本摘要。
    rejected.push(textAiProvider().generateText);
    // @ts-expect-error 生图路由不承载语音转写。
    rejected.push(imageAiProvider()?.transcribeVoice);
    // @ts-expect-error 生歌路由不承载生图。
    rejected.push(songAiProvider()?.generateImage);
  };
  expect(typeof assertCrossCapabilityCallsRejected).toBe("function");
});
