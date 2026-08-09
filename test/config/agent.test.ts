import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { AdDetectAgentConfig, AgentDeploymentConfig } from "../../packages/types/config";

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
  song: { provider: "google", api_key: "google-song-key", model: "lyria-test" },
};

const tempDirs: string[] = [];

function writeConfig(value: unknown): string {
  const directory: string = mkdtempSync(join(tmpdir(), "agent-config-test-"));
  tempDirs.push(directory);
  const path: string = join(directory, "agent.json");
  writeFileSync(path, JSON.stringify(value));
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
      song: { provider: "google", apiKey: "google-song-key", baseUrl: undefined, model: "lyria-test" },
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

  test("三项对话必备能力不能缺，image 与 song 可缺省", () => {
    for (const missing of ["text", "summary", "media"] as const) {
      const value: Record<string, unknown> = { ...AGENT };
      delete value[missing];
      expect(() => parseAgentDeploymentConfig(value, "agent.json"))
        .toThrow(/agent must be exactly \{ ad_detect\?, text, summary, media, image\?, song\? \}/);
    }
    const withoutSong: Record<string, unknown> = { ...AGENT };
    delete withoutSong.song;
    expect(parseAgentDeploymentConfig(withoutSong, "agent.json").song).toBeUndefined();
    delete withoutSong.image;
    expect(parseAgentDeploymentConfig(withoutSong, "agent.json").image).toBeUndefined();
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
    }, "agent.json")).toThrow(/agent\.text must be exactly \{ provider, api_key, base_url\?, model \}/);
    expect(() => parseAgentDeploymentConfig({
      ...AGENT,
      text: { provider: "google", api_key: "  ", model: "m" },
    }, "agent.json")).toThrow(/agent\.text\.api_key must be a non-empty string/);
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
      model: "gemini-image",
      imageProtocol: undefined,
    });
  });

  test("song 可选择任一已支持 provider，由工具装配判断实现能力", () => {
    const parsed: AgentDeploymentConfig = parseAgentDeploymentConfig({
      ...AGENT,
      song: { provider: "openai", api_key: "key", model: "song-model" },
    }, "agent.json");
    expect(parsed.song).toEqual({
      provider: "openai",
      apiKey: "key",
      baseUrl: undefined,
      model: "song-model",
    });
  });
});

describe("unified agent.json loading", () => {
  test("广告端点缺省时跟随 provider SDK 的官方地址", () => {
    expect(parseAdDetectAgentConfig({ provider: "openai", api_key: "deepseek-key", model: "deepseek-test" }, "agent.json"))
      .toEqual({ provider: "openai", apiKey: "deepseek-key", baseUrl: undefined, model: "deepseek-test" });
    expect(parseAdDetectAgentConfig({
      provider: "google",
      api_key: "google-key",
      model: "gemini-ad",
    }, "agent.json")).toEqual({
      provider: "google",
      apiKey: "google-key",
      baseUrl: undefined,
      model: "gemini-ad",
    });
  });

  test("分段加载互不解析另一段", () => {
    const badAgentPath: string = writeConfig({ agent: { ad_detect: AD_DETECT, bad: true } });
    expect(loadAdDetectAgentConfig(badAgentPath)).toEqual({
      provider: "openai",
      apiKey: "deepseek-key",
      baseUrl: "https://deepseek.example/v1",
      model: "deepseek-test",
    });
    const badAdPath: string = writeConfig({ agent: { ...AGENT, ad_detect: { bad: true } } });
    expect(loadAgentDeploymentConfig(badAdPath).text.model).toBe("gemini-text");
  });

  test("启动总闸允许功能级可选能力缺省，但拒绝已存在的非法能力", () => {
    const validPath: string = writeConfig({ agent: AGENT });
    expect(() => validateAgentDeploymentConfig(validPath)).not.toThrow();
    const withoutAdDetect: Record<string, unknown> = { ...AGENT };
    delete withoutAdDetect.ad_detect;
    const missingPath: string = writeConfig({ agent: withoutAdDetect });
    expect(() => validateAgentDeploymentConfig(missingPath)).not.toThrow();
    const adOnlyPath: string = writeConfig({ agent: { ad_detect: AD_DETECT } });
    expect(() => validateAgentDeploymentConfig(adOnlyPath)).not.toThrow();
    expect(() => loadAgentDeploymentConfig(adOnlyPath)).toThrow(/agent must be exactly/);
    const invalidPath: string = writeConfig({ agent: { ...AGENT, ad_detect: { bad: true } } });
    expect(() => validateAgentDeploymentConfig(invalidPath)).toThrow(/agent\.ad_detect/);
    const extraPath: string = writeConfig({ agent: AGENT, gemini: {} });
    expect(() => validateAgentDeploymentConfig(extraPath)).toThrow(/must be exactly \{ agent \}/);
  });

  test("运行时 getter 只读 holder，取不到就 fail-closed 而不读盘", () => {
    const agentValue: AgentDeploymentConfig = parseAgentDeploymentConfig(AGENT, "agent.json");
    adoptAgentDeploymentConfig(agentValue);
    expect(getAgentDeploymentConfig()).toBe(agentValue);
    const adValue: AdDetectAgentConfig = {
      provider: "openai",
      apiKey: "deepseek-key",
      baseUrl: "https://deepseek.example/v1",
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

  test("readiness 探测入口在 holder 已填时不再解析", () => {
    // 启动总闸先填好两段快照，探测就只剩一次分支：已存在的文件在一个进程里
    // 只解析一次，探测与运行时读的是同一个对象。
    const agentValue: AgentDeploymentConfig = parseAgentDeploymentConfig(AGENT, "agent.json");
    adoptAgentDeploymentConfig(agentValue);
    ensureAgentDeploymentConfig();
    expect(agentDeploymentConfigCache.current).toBe(agentValue);

    const adValue: AdDetectAgentConfig = parseAdDetectAgentConfig(AD_DETECT, "agent.json");
    adoptAdDetectAgentConfig(adValue);
    ensureAdDetectAgentConfig();
    expect(adDetectAgentConfigSnapshot()).toBe(adValue);
  });
});
