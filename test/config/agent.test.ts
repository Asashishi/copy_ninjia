import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  adDetectAgentConfigSnapshot,
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  ensureAdDetectAgentConfig,
  ensureAgentDeploymentConfig,
  getAdDetectAgentConfig,
  getAgentDeploymentConfig,
  loadAdDetectAgentConfig,
  loadAgentDeploymentConfig,
  parseAdDetectAgentConfig,
  parseAgentDeploymentConfig,
  validateAgentDeploymentConfig,
} from "../../packages/config/agent";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
} from "../../packages/cache/perThread/config";
import { AGENT_CONFIG_PATH, CONFIG_ROOT } from "../../packages/consts/paths";
import { AGENT_HEADERS_MAX_ENTRIES } from "../../packages/consts/agent";
import { GEMINI_SPEECH_STYLE } from "../../packages/consts/aiChat/gemini";
import { TTS_DEFAULT_DAILY_LIMIT, TTS_DEFAULT_DAILY_RESERVE_QUOTA } from "../../packages/consts/aiChat/voiceMessage";
import type { AdDetectAgentConfig, AgentDeploymentConfig, AgentTtsCapabilityConfig } from "../../packages/types/config";

const AD_DETECT: Readonly<Record<string, string>> = {
  provider: "openai",
  api_key: "deepseek-key",
  base_url: "https://deepseek.example/v1",
  model: "deepseek-test",
};

const AGENT: Readonly<Record<string, unknown>> = {
  ad_detect: AD_DETECT,
  text: { provider: "google", api_key: "google-text-key", model: "gemini-text" },
  summary: { provider: "openai", api_key: "openai-summary-key", base_url: "https://openai.example/v1", model: "gpt-summary" },
  media: { provider: "google", api_key: "google-media-key", base_url: "https://google.example", model: "gemini-media" },
  image: {
    provider: "openai",
    api_key: "xai-image-key",
    base_url: "https://xai.example/v1",
    model: "grok-image",
    image_protocol: "xai",
  },
  tts: { provider: "google", api_key: "google-tts-key", model: "tts-test", voice: "Leda" },
};

const AGENT_EXAMPLE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = (
  JSON.parse(
    await Bun.file(join(import.meta.dir, "..", "..", "config_example", relative(CONFIG_ROOT, AGENT_CONFIG_PATH))).text()
  ) as { readonly agent: Readonly<Record<string, Readonly<Record<string, unknown>>>> }
).agent;

const tempDirs: string[] = [];

async function writeConfig(value: unknown): Promise<string> {
  const directory: string = mkdtempSync(join(tmpdir(), "agent-config-test-"));
  tempDirs.push(directory);
  const path: string = join(directory, "agent.json");
  await Bun.write(path, JSON.stringify(value));
  return path;
}

beforeEach((): void => {
  adDetectAgentConfigCache.current = null;
  agentDeploymentConfigCache.current = null;
});

afterEach((): void => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent capability config", () => {
  test("按能力保留 provider、api_key、model 与各自 base_url", () => {
    const parsed: AgentDeploymentConfig = parseAgentDeploymentConfig(AGENT, "agent.json");
    expect(parsed).toEqual({
      text: { provider: "google", apiKey: "google-text-key", baseUrl: undefined, headers: undefined, model: "gemini-text" },
      summary: { provider: "openai", apiKey: "openai-summary-key", baseUrl: "https://openai.example/v1", headers: undefined, model: "gpt-summary" },
      media: { provider: "google", apiKey: "google-media-key", baseUrl: "https://google.example", headers: undefined, model: "gemini-media" },
      image: {
        provider: "openai",
        apiKey: "xai-image-key",
        baseUrl: "https://xai.example/v1",
        headers: undefined,
        model: "grok-image",
        imageProtocol: "xai",
      },
      tts: { provider: "google", apiKey: "google-tts-key", baseUrl: undefined, headers: undefined, model: "tts-test", voice: "Leda", style: GEMINI_SPEECH_STYLE, dailyLimit: 100, dailyReserveQuota: 25 },
    });
  });

  test("provider 只接受 google 与 openai", () => {
    for (const provider of ["gemini", "gpt", "xai", ""] as const) {
      expect(() => parseAgentDeploymentConfig({
        ...AGENT,
        text: { provider, api_key: "key", model: "m" },
      }, "agent.json")).toThrow(/agent\.text\.provider must be "google" or "openai"/);
    }
  });

  test("三项对话必备能力不能缺，image 与 tts 可缺省", () => {
    for (const missing of ["text", "summary", "media"] as const) {
      const value: Record<string, unknown> = { ...AGENT };
      delete value[missing];
      expect(() => parseAgentDeploymentConfig(value, "agent.json"))
        .toThrow(/agent must be exactly \{ ad_detect\?, text, summary, media, image\?, tts\? \}/);
    }
    const withoutOptional: Record<string, unknown> = { ...AGENT };
    delete withoutOptional.image;
    expect(parseAgentDeploymentConfig(withoutOptional, "agent.json").image).toBeUndefined();
    delete withoutOptional.tts;
    expect(parseAgentDeploymentConfig(withoutOptional, "agent.json").tts).toBeUndefined();
  });

  test("模型、端点与未知键严格校验", () => {
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      summary: { provider: "openai", api_key: "key", model: "  " },
    }, "agent.json")).toThrow(/agent\.summary\.model must be a non-empty string/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      media: { provider: "google", api_key: "key", model: "m", base_url: "google.example" },
    }, "agent.json")).toThrow(/agent\.media\.base_url must be an absolute https URL/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      text: { provider: "google", api_key: "key", model: "m", baseURL: "https://wrong.example" },
    }, "agent.json")).toThrow(/agent\.text must be exactly \{ provider, api_key, base_url\?, headers\?, model \} when provider is google/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      text: { provider: "google", api_key: "  ", model: "m" },
    }, "agent.json")).toThrow(/agent\.text\.api_key must be a non-empty string/);
  });

  test("所有能力只拒绝示例中的实际占位凭据，且错误不回显凭据", async () => {
    for (const capability of ["ad_detect", "text", "summary", "media", "image", "tts"] as const) {
      const exampleCapability: Readonly<Record<string, unknown>> | undefined = AGENT_EXAMPLE[capability];
      const placeholder: unknown = exampleCapability?.api_key;
      if (typeof placeholder !== "string") throw new Error(`missing example api_key for ${capability}`);
      const capabilityConfig: Readonly<Record<string, unknown>> = AGENT[capability] as Readonly<Record<string, unknown>>;
      const value: Readonly<Record<string, unknown>> = {
        ...AGENT,
        [capability]: { ...capabilityConfig, api_key: placeholder },
      };
      const path: string = await writeConfig({ agent: value });
      const validate: Promise<void> = validateAgentDeploymentConfig(path);
      await expect(validate).rejects.toThrow(
        `${path}: $.agent.${capability}.api_key must be a configured non-placeholder string`
      );
      await expect(validate).rejects.not.toThrow(placeholder);
    }
    expect(parseAgentDeploymentConfig({
      ...AGENT,
      text: { provider: "google", api_key: "replace-with-private-api-key", model: "m" },
    }, "agent.json").text.apiKey).toBe("replace-with-private-api-key");
  });

  test("base_url 默认只收 HTTPS，明文 HTTP 仅限本机回环", () => {
    for (const baseUrl of [
      "http://api.example.com/v1",
      "http://10.0.0.5:8080/v1",
      "ftp://api.example.com",
      "ws://localhost:8080",
    ]) {
      expect(() => parseAgentDeploymentConfig({
        ...AGENT,
        media: { provider: "google", api_key: "key", model: "m", base_url: baseUrl },
      }, "agent.json")).toThrow(/agent\.media\.base_url must be an absolute https URL/);
    }
    for (const baseUrl of [
      "https://api.example.com/v1",
      "http://localhost:8080/v1",
      "http://127.0.0.1:8080/v1",
      "http://[::1]:8080/v1",
    ]) {
      expect(parseAgentDeploymentConfig({
        ...AGENT,
        media: { provider: "google", api_key: "key", model: "m", base_url: baseUrl },
      }, "agent.json").media.baseUrl).toBe(baseUrl);
    }
  });

  test("base_url 拒绝 userinfo 与 fragment，且拒绝文案不回显被拒的值", () => {
    const credentialUrl: string = "https://leaked-user:leaked-secret@api.example.com/v1";
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      summary: { provider: "openai", api_key: "key", model: "m", base_url: credentialUrl },
    }, "agent.json")).toThrow(/agent\.summary\.base_url must be an absolute https URL/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      summary: { provider: "openai", api_key: "key", model: "m", base_url: credentialUrl },
    }, "agent.json")).not.toThrow(/leaked-secret/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      summary: { provider: "openai", api_key: "key", model: "m", base_url: "https://api.example.com/v1#frag" },
    }, "agent.json")).toThrow(/agent\.summary\.base_url must be an absolute https URL/);
  });

  test("OpenAI 生图必须显式协议，Google 生图禁止该字段", () => {
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      image: { provider: "openai", api_key: "key", model: "gpt-image" },
    }, "agent.json")).toThrow(/agent\.image\.image_protocol must be/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      image: { provider: "google", api_key: "key", model: "gemini-image", image_protocol: "openai" },
    }, "agent.json")).toThrow(/when provider is google/);
    const parsed: AgentDeploymentConfig = parseAgentDeploymentConfig({
      ...AGENT,
      image: { provider: "google", api_key: "key", model: "gemini-image" },
    }, "agent.json");
    expect(parsed.image).toEqual({
      provider: "google",
      apiKey: "key",
      baseUrl: undefined,
      headers: undefined,
      model: "gemini-image",
      imageProtocol: undefined,
    });
  });

  test("tts 可选择任一已支持 provider，由工具装配判断实现能力", () => {
    const parsed: AgentDeploymentConfig = parseAgentDeploymentConfig({
      ...AGENT,
      tts: { provider: "openai", api_key: "key", model: "tts-model", voice: "Leda" },
    }, "agent.json");
    expect(parsed.tts).toEqual({
      provider: "openai",
      apiKey: "key",
      baseUrl: undefined,
      headers: undefined,
      model: "tts-model",
      voice: "Leda",
      style: GEMINI_SPEECH_STYLE,
      dailyLimit: 100,
      dailyReserveQuota: 25,
    });
  });

  test("能力名单之外的键（如 song）一律拒绝", () => {
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      song: { provider: "google", api_key: "key", model: "lyria" },
    }, "agent.json")).toThrow(/agent must be exactly \{ ad_detect\?, text, summary, media, image\?, tts\? \}/);
  });
});

describe("agent google headers", () => {
  const GATEWAY_TOKEN: string = "Bearer cf-aig-secret-token";

  test("google provider 的 headers 原样生效，各能力都可声明", () => {
    const parsed: AgentDeploymentConfig = parseAgentDeploymentConfig({
      ...AGENT,
      text: { provider: "google", api_key: "key", model: "m", headers: { "cf-aig-authorization": GATEWAY_TOKEN } },
      image: { provider: "google", api_key: "key", model: "img", headers: { "X-Trace": " trace-1 " } },
      tts: {
        provider: "google",
        api_key: "key",
        base_url: "https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio",
        model: "tts-test",
        voice: "Leda",
        headers: { "cf-aig-authorization": GATEWAY_TOKEN },
      },
    }, "agent.json");
    expect(parsed.text.headers).toStrictEqual({ "cf-aig-authorization": GATEWAY_TOKEN });
    expect(parsed.image?.headers).toStrictEqual({ "X-Trace": "trace-1" });
    expect(parsed.tts?.headers).toStrictEqual({ "cf-aig-authorization": GATEWAY_TOKEN });
    expect(parsed.summary.headers).toBeUndefined();
    const adDetect: AdDetectAgentConfig = parseAdDetectAgentConfig(
      { provider: "google", api_key: "key", model: "m", headers: { "cf-aig-authorization": GATEWAY_TOKEN } },
      "agent.json"
    );
    expect(adDetect.headers).toStrictEqual({ "cf-aig-authorization": GATEWAY_TOKEN });
  });

  test("openai provider 不接受 headers", () => {
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      summary: { provider: "openai", api_key: "key", model: "m", headers: { "x-a": "b" } },
    }, "agent.json")).toThrow(/agent\.summary must be exactly \{ provider, api_key, base_url\?, model \} when provider is openai/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      tts: { provider: "openai", api_key: "key", model: "m", voice: "Leda", headers: { "x-a": "b" } },
    }, "agent.json")).toThrow(/agent\.tts must be exactly \{ provider, api_key, base_url\?, model, voice, style\?, daily_limit\?, daily_reserve_quota\? \} when provider is openai/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      image: { provider: "openai", api_key: "key", model: "m", image_protocol: "xai", headers: { "x-a": "b" } },
    }, "agent.json")).toThrow(/agent\.image must be exactly \{ provider, api_key, base_url\?, model, image_protocol \} when provider is openai/);
  });

  test("headers 对象与请求头名非法时拒绝在 headers 路径上", () => {
    const tooMany: Record<string, string> = {};
    for (let index: number = 0; index <= AGENT_HEADERS_MAX_ENTRIES; index++) tooMany[`x-h${index}`] = "v";
    for (const headers of [
      {},
      [],
      "cf-aig-authorization: token",
      tooMany,
      { "bad name": "v" },
      { "": "v" },
      { "X-Goog-Api-Key": "v" },
      { "x-a": "1", "X-A": "2" },
    ] as const) {
      expect(() => parseAgentDeploymentConfig({
        ...AGENT,
        text: { provider: "google", api_key: "key", model: "m", headers },
      }, "agent.json")).toThrow(/agent\.text\.headers must be an object of 1 to \d+ HTTP header names/);
    }
  });

  test("请求头值非法时拒绝在该请求头路径上，且不回显值", () => {
    for (const value of [1, null, "   ", `${GATEWAY_TOKEN}\r\nx-injected: 1`, "令牌"] as const) {
      const run = (): AgentDeploymentConfig => parseAgentDeploymentConfig({
        ...AGENT,
        media: { provider: "google", api_key: "key", model: "m", headers: { "cf-aig-authorization": value } },
      }, "agent.json");
      expect(run).toThrow(/agent\.media\.headers\.cf-aig-authorization must be a non-empty string/);
      if (typeof value === "string" && value.trim().length > 0) expect(run).not.toThrow(value);
    }
  });
});

describe("agent tts capability", () => {
  test("style 缺省沿用常量，自定义先 trim，存在但非法时拒绝", () => {
    const base = { provider: "google", api_key: "key", model: "m", voice: "fixture" };
    expect(parseAgentDeploymentConfig({ ...AGENT, tts: base }, "agent.json").tts?.style).toBe(GEMINI_SPEECH_STYLE);
    expect(parseAgentDeploymentConfig({ ...AGENT, tts: { ...base, style: "  cheerful  " } }, "agent.json").tts?.style).toBe("cheerful");
    for (const style of [null, 7, true, {}, [], "", " \n\t"]) {
      expect(() => parseAgentDeploymentConfig({ ...AGENT, tts: { ...base, style } }, "agent.json"))
        .toThrow(/agent\.tts\.style must be a non-empty string/);
    }
  });
  test("tts 非法时带字段路径拒绝，已存在的非法 tts 同样阻止整份文件加载", async () => {
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      tts: { provider: "google", api_key: "key", model: "m", voice: "Leda", unknown: "value" },
    }, "agent.json")).toThrow(/agent\.tts must be exactly \{ provider, api_key, base_url\?, headers\?, model, voice, style\?, daily_limit\?, daily_reserve_quota\? \} when provider is google/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      tts: { provider: "google", api_key: "key", model: "m" },
    }, "agent.json")).toThrow(/agent\.tts\.voice must be a non-empty string/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      tts: { provider: "google", api_key: "key", model: "m", voice: "  " },
    }, "agent.json")).toThrow(/agent\.tts\.voice must be a non-empty string/);
    expect(parseAgentDeploymentConfig({
      ...AGENT,
      tts: { provider: "google", api_key: "key", model: "m", voice: " voice_abc123 " },
    }, "agent.json").tts?.voice).toBe("voice_abc123");
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      tts: { provider: "google", api_key: "key", model: "", voice: "Leda" },
    }, "agent.json")).toThrow(/agent\.tts\.model must be a non-empty string/);
    const path: string = await writeConfig({ agent: { ad_detect: AD_DETECT, tts: { provider: "azure", api_key: "k", model: "m", voice: "Leda" } } });
    await expect(validateAgentDeploymentConfig(path)).rejects.toThrow(
      `${path}: $.agent.tts.provider must be "google" or "openai"`
    );
  });

  test("daily_limit 与 daily_reserve_quota 缺省取默认值，显式给出时原样生效", () => {
    const base: Readonly<Record<string, unknown>> = { provider: "google", api_key: "key", model: "m", voice: "Leda" };
    const defaults: AgentTtsCapabilityConfig | undefined = parseAgentDeploymentConfig({ ...AGENT, tts: base }, "agent.json").tts;
    expect(defaults?.dailyLimit).toBe(TTS_DEFAULT_DAILY_LIMIT);
    expect(defaults?.dailyReserveQuota).toBe(TTS_DEFAULT_DAILY_RESERVE_QUOTA);
    const custom: AgentTtsCapabilityConfig | undefined = parseAgentDeploymentConfig({
      ...AGENT,
      tts: { ...base, daily_limit: 40, daily_reserve_quota: 0 },
    }, "agent.json").tts;
    expect(custom?.dailyLimit).toBe(40);
    expect(custom?.dailyReserveQuota).toBe(0);
    expect(parseAgentDeploymentConfig({
      ...AGENT,
      tts: { ...base, daily_limit: 10, daily_reserve_quota: 9 },
    }, "agent.json").tts?.dailyReserveQuota).toBe(9);
  });

  test("daily_limit 与 daily_reserve_quota 非法或 daily_reserve_quota 不小于 daily_limit 时带字段路径拒绝", () => {
    const base: Readonly<Record<string, unknown>> = { provider: "google", api_key: "key", model: "m", voice: "Leda" };
    for (const limit of [0, -1, 1.5, "100", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseAgentDeploymentConfig({ ...AGENT, tts: { ...base, daily_limit: limit } }, "agent.json"))
        .toThrow(/agent\.tts\.daily_limit must be a positive integer/);
    }
    for (const reserveQuota of [-1, 2.5, "5", null, 50]) {
      expect(() => parseAgentDeploymentConfig({ ...AGENT, tts: { ...base, daily_limit: 50, daily_reserve_quota: reserveQuota } }, "agent.json"))
        .toThrow(/agent\.tts\.daily_reserve_quota must be an integer from 0 to 49/);
    }
    // daily_limit 调到默认预留以下而 daily_reserve_quota 缺省：默认值同样要满足 0～daily_limit-1。
    expect(() => parseAgentDeploymentConfig({ ...AGENT, tts: { ...base, daily_limit: TTS_DEFAULT_DAILY_RESERVE_QUOTA } }, "agent.json"))
      .toThrow(new RegExp(`agent\\.tts\\.daily_reserve_quota must be an integer from 0 to ${TTS_DEFAULT_DAILY_RESERVE_QUOTA - 1}`));
  });
});

describe("unified agent.json loading", () => {
  test("广告端点缺省时跟随 provider SDK 的官方地址", () => {
    expect(parseAdDetectAgentConfig({ provider: "openai", api_key: "deepseek-key", model: "deepseek-test" }, "agent.json"))
      .toEqual({ provider: "openai", apiKey: "deepseek-key", baseUrl: undefined, headers: undefined, model: "deepseek-test" });
    expect(parseAdDetectAgentConfig({
      provider: "google",
      api_key: "google-key",
      model: "gemini-ad",
    }, "agent.json")).toEqual({
      provider: "google",
      apiKey: "google-key",
      baseUrl: undefined,
      headers: undefined,
      model: "gemini-ad",
    });
  });

  test("分段加载互不解析另一段", async () => {
    const badAgentPath: string = await writeConfig({ agent: { ad_detect: AD_DETECT, bad: true } });
    expect(await loadAdDetectAgentConfig(badAgentPath)).toEqual({
      provider: "openai",
      apiKey: "deepseek-key",
      baseUrl: "https://deepseek.example/v1",
      headers: undefined,
      model: "deepseek-test",
    });
    const badAdPath: string = await writeConfig({ agent: { ...AGENT, ad_detect: { bad: true } } });
    expect((await loadAgentDeploymentConfig(badAdPath)).text.model).toBe("gemini-text");
  });

  test("启动总闸允许功能级可选能力缺省，但拒绝已存在的非法能力", async () => {
    const validPath: string = await writeConfig({ agent: AGENT });
    await expect(validateAgentDeploymentConfig(validPath)).resolves.toBeUndefined();
    const withoutAdDetect: Record<string, unknown> = { ...AGENT };
    delete withoutAdDetect.ad_detect;
    const missingPath: string = await writeConfig({ agent: withoutAdDetect });
    await expect(validateAgentDeploymentConfig(missingPath)).resolves.toBeUndefined();
    const adOnlyPath: string = await writeConfig({ agent: { ad_detect: AD_DETECT } });
    await expect(validateAgentDeploymentConfig(adOnlyPath)).resolves.toBeUndefined();
    await expect(loadAgentDeploymentConfig(adOnlyPath)).rejects.toThrow(/agent must be exactly/);
    const invalidPath: string = await writeConfig({ agent: { ...AGENT, ad_detect: { bad: true } } });
    await expect(validateAgentDeploymentConfig(invalidPath)).rejects.toThrow(/agent\.ad_detect/);
    const extraPath: string = await writeConfig({ agent: AGENT, gemini: {} });
    await expect(validateAgentDeploymentConfig(extraPath)).rejects.toThrow(/must be exactly \{ agent \}/);
  });

  test("运行时 getter 只读 holder，取不到就 fail-closed 而不读盘", () => {
    const agentValue: AgentDeploymentConfig = parseAgentDeploymentConfig(AGENT, "agent.json");
    adoptAgentDeploymentConfig(agentValue);
    expect(getAgentDeploymentConfig()).toBe(agentValue);
    const adValue: AdDetectAgentConfig = {
      provider: "openai",
      apiKey: "deepseek-key",
      baseUrl: "https://deepseek.example/v1",
      headers: undefined,
      model: "deepseek-test",
    };
    adoptAdDetectAgentConfig(adValue);
    expect(getAdDetectAgentConfig()).toBe(adValue);
    expect(adDetectAgentConfigSnapshot()).toBe(adValue);

    // 明确未配置也用同一条通道表达；Worker 不得沿用上一实例的值。
    adoptAdDetectAgentConfig(null);
    expect(adDetectAgentConfigSnapshot()).toBeNull();
    expect(() => getAdDetectAgentConfig()).toThrow(/ad_detect was never delivered/);

    agentDeploymentConfigCache.current = null;
    expect(() => getAgentDeploymentConfig()).toThrow(/was never delivered/);
    // 拒绝时不得回显任何凭据。
    expect(() => getAgentDeploymentConfig()).not.toThrow(/google-text-key/);
  });

  test("readiness 探测入口在 holder 已填时不再解析", async () => {
    // 启动总闸先填好两段快照，探测就只剩一次分支：已存在的文件在一个进程里
    // 只解析一次，探测与运行时读的是同一个对象。
    const agentValue: AgentDeploymentConfig = parseAgentDeploymentConfig(AGENT, "agent.json");
    adoptAgentDeploymentConfig(agentValue);
    await ensureAgentDeploymentConfig();
    expect(agentDeploymentConfigCache.current).toBe(agentValue);

    const adValue: AdDetectAgentConfig = parseAdDetectAgentConfig(AD_DETECT, "agent.json");
    adoptAdDetectAgentConfig(adValue);
    await ensureAdDetectAgentConfig();
    expect(adDetectAgentConfigSnapshot()).toBe(adValue);
  });
});
