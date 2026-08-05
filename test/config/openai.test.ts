/**
 * config/openai.json 的解析：**整份必填、模型名一个都不能少**，写了就必须写对。
 *
 * 重点守四条：
 * 1. 代码里不再有任何模型默认值——缺文件、缺段、缺模型名一律抛错，绝不静默兜底。
 *    有默认值就意味着「配错了也能跑起来」，运维要到对账时才发现自己以为换掉的
 *    模型从没生效过。
 * 2. 仍然可选的只有两处**端点**：ad_detect.base_url 缺省走官方地址，
 *    ai_agent.base_url 缺省走 SDK 自带端点。端点有公认默认值，模型没有。
 * 3. 两段分开加载：ai_agent 写坏不该拖垮只读 ad_detect 的广告检测，反之亦然。
 * 4. 分段一路贯穿到**运行时访问器与缓存**：这一条是回归守卫。曾经运行时侧只有
 *    一个整份文件的访问器与一对共用 holder，于是 ai_agent 的笔误先通过
 *    adDetectConfigReadiness() 与启动 preflight，再让每条候选消息在取模型名时
 *    抛错、被上游 catch 吞成 verdict=null，且失败态缓存到进程退出为止。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAdDetectOpenAiConfig,
  getAiAgentOpenAiConfig,
  loadAdDetectOpenAiConfig,
  loadAiAgentOpenAiConfig,
  parseAdDetectOpenAiConfig,
  parseAiAgentOpenAiConfig,
} from "../../packages/config/openai";
import {
  adDetectOpenAiConfigCache,
  adDetectOpenAiConfigFailure,
  aiAgentOpenAiConfigCache,
  aiAgentOpenAiConfigFailure,
} from "../../packages/cache/perThread/config";
import { DEEPSEEK_API_BASE_URL } from "../../packages/consts/deepseek";
import type { AdDetectOpenAiConfig, AiAgentOpenAiConfig } from "../../packages/types/config";

/** 把一份 JSON 写进临时目录，返回路径。 */
function writeConfig(content: string): string {
  const dir: string = mkdtempSync(join(tmpdir(), "openai-config-test-"));
  const path: string = join(dir, "openai.json");
  writeFileSync(path, content, "utf8");
  return path;
}

/** 一份最小的合法 ad_detect 段；只想验另一半时用它占位。 */
const AD_DETECT = { base_url: "https://ds.example", model: "ad-model" } as const;
/** 一份最小的合法 ai_agent 段，同上。 */
const AI_AGENT = { models: { reply: "r", summary: "s", media: "m", image: "i" } } as const;

describe("缺省一律拒绝：代码里没有默认模型可退", () => {
  test("段整块缺失时两侧都拒绝", () => {
    expect(() => parseAdDetectOpenAiConfig(undefined)).toThrow(/ad_detect must be an object/);
    expect(() => parseAiAgentOpenAiConfig(undefined)).toThrow(/ai_agent must be an object/);
  });

  test("文件不存在直接抛错，不再按默认值兜底", () => {
    const absent: string = join(tmpdir(), "definitely-absent-openai.json");
    expect(() => loadAdDetectOpenAiConfig(absent)).toThrow();
    expect(() => loadAiAgentOpenAiConfig(absent)).toThrow();
  });

  test("models 缺任意一档都拒绝，不再拿默认值补齐", () => {
    for (const missing of ["reply", "summary", "media", "image"] as const) {
      const models: Record<string, string> = { reply: "r", summary: "s", media: "m", image: "i" };
      delete models[missing];
      expect(() => parseAiAgentOpenAiConfig({ models }))
        .toThrow(new RegExp(`ai_agent\\.models\\.${missing} must be a non-empty string`));
    }
  });

  test("models 整块缺失同样拒绝", () => {
    expect(() => parseAiAgentOpenAiConfig({ base_url: "https://x.example/v1" }))
      .toThrow(/ai_agent\.models must be an object/);
  });

  test("ad_detect.model 缺失拒绝", () => {
    expect(() => parseAdDetectOpenAiConfig({ base_url: "https://ds.example" }))
      .toThrow(/ad_detect\.model must be a non-empty string/);
  });
});

describe("端点仍可缺省：它有公认默认值，模型没有", () => {
  test("ad_detect.base_url 缺省走官方地址", () => {
    const parsed: AdDetectOpenAiConfig = parseAdDetectOpenAiConfig({ model: "ad-model" });
    expect(parsed).toEqual({ baseUrl: DEEPSEEK_API_BASE_URL, model: "ad-model" });
  });

  test("ai_agent.base_url 缺省表示走 SDK 自带的官方端点", () => {
    const parsed: AiAgentOpenAiConfig = parseAiAgentOpenAiConfig(AI_AGENT);
    expect(parsed.baseUrl).toBeUndefined();
  });
});

describe("完整配置逐字段生效", () => {
  test("从文件读出的两条线都按配置值", () => {
    const path: string = writeConfig(JSON.stringify({
      ad_detect: { base_url: "https://ds.example", model: "ad-model" },
      ai_agent: {
        base_url: "https://chat.example/v1",
        models: { reply: "r", summary: "s", media: "m", image: "i" },
      },
    }));
    expect(loadAdDetectOpenAiConfig(path)).toEqual({ baseUrl: "https://ds.example", model: "ad-model" });
    expect(loadAiAgentOpenAiConfig(path)).toEqual({
      baseUrl: "https://chat.example/v1",
      models: { reply: "r", summary: "s", media: "m", image: "i" },
    });
  });
});

describe("分段加载：两条线各读各的半边", () => {
  test("ai_agent 段写坏不影响 ad_detect 段的加载，反之亦然", () => {
    const brokenAiAgent: string = writeConfig(JSON.stringify({
      ad_detect: AD_DETECT,
      // 单数 model 是最常见的手误：ai_agent 侧会抛，但广告检测一个字段都不读这里。
      ai_agent: { model: "gpt-5.4-mini" },
    }));
    expect(loadAdDetectOpenAiConfig(brokenAiAgent)).toEqual({ baseUrl: "https://ds.example", model: "ad-model" });
    expect(() => loadAiAgentOpenAiConfig(brokenAiAgent)).toThrow(/ai_agent must be an object/);

    const brokenAdDetect: string = writeConfig(JSON.stringify({
      ad_detect: { baseURL: "https://ds.example" },
      ai_agent: AI_AGENT,
    }));
    expect(loadAiAgentOpenAiConfig(brokenAdDetect).models.reply).toBe("r");
    expect(() => loadAdDetectOpenAiConfig(brokenAdDetect)).toThrow(/ad_detect must be an object/);
  });

  test("整段缺失时只有那一段拒绝：只配一家的部署照样跑得起另一家", () => {
    // Gemini 部署根本不写 ai_agent 段，广告检测却仍要能用。
    const onlyAdDetect: string = writeConfig(JSON.stringify({ ad_detect: AD_DETECT }));
    expect(loadAdDetectOpenAiConfig(onlyAdDetect)).toEqual({ baseUrl: "https://ds.example", model: "ad-model" });
    expect(() => loadAiAgentOpenAiConfig(onlyAdDetect)).toThrow(/ai_agent must be an object/);

    const onlyAiAgent: string = writeConfig(JSON.stringify({ ai_agent: AI_AGENT }));
    expect(loadAiAgentOpenAiConfig(onlyAiAgent).models.reply).toBe("r");
    expect(() => loadAdDetectOpenAiConfig(onlyAiAgent)).toThrow(/ad_detect must be an object/);
  });

  test("顶层形状仍是两段共用的前提：整份不是对象时谁也读不出自己那段", () => {
    const path: string = writeConfig(JSON.stringify(["ad_detect"]));
    expect(() => loadAdDetectOpenAiConfig(path)).toThrow(/expected an object/);
    expect(() => loadAiAgentOpenAiConfig(path)).toThrow(/expected an object/);
  });
});

describe("写坏一律抛错，不静默退回默认值", () => {
  test("顶层未知键", () => {
    const path: string = writeConfig(JSON.stringify({ adDetect: {} }));
    expect(() => loadAdDetectOpenAiConfig(path)).toThrow(/ad_detect\?, ai_agent\?/);
  });

  test("顶层不是对象", () => {
    expect(() => loadAdDetectOpenAiConfig(writeConfig("[]"))).toThrow(/expected an object/);
    expect(() => loadAdDetectOpenAiConfig(writeConfig("\"x\""))).toThrow(/expected an object/);
  });

  test("对象内未知键——拼错的键被无声忽略最危险", () => {
    expect(() => parseAiAgentOpenAiConfig({ baseUrl: "https://x.example" }))
      .toThrow(/ai_agent must be an object/);
    expect(() => parseAiAgentOpenAiConfig({ models: { replies: "x" } }))
      .toThrow(/ai_agent\.models must be an object/);
    expect(() => parseAdDetectOpenAiConfig({ baseURL: "https://x.example" }))
      .toThrow(/ad_detect must be an object/);
  });

  test("空串与非字符串模型名", () => {
    expect(() => parseAiAgentOpenAiConfig({ models: { ...AI_AGENT.models, reply: "  " } }))
      .toThrow(/ai_agent\.models\.reply must be a non-empty string/);
    expect(() => parseAdDetectOpenAiConfig({ model: 42 }))
      .toThrow(/ad_detect\.model must be a non-empty string/);
  });

  test("端点缺 scheme 或用了非 http(s) 协议", () => {
    // 少写 scheme 是最常见的手误，SDK 收到它只会在第一次真实请求时报个无关的错。
    expect(() => parseAiAgentOpenAiConfig({ ...AI_AGENT, base_url: "ai.example.com/v1" }))
      .toThrow(/must be an absolute http\(s\) URL/);
    expect(() => parseAdDetectOpenAiConfig({ ...AD_DETECT, base_url: "ftp://ds.example" }))
      .toThrow(/must use http or https/);
  });

  test("文件存在但不是合法 JSON", () => {
    const path: string = writeConfig("{ nope");
    expect(() => loadAdDetectOpenAiConfig(path)).toThrow();
    expect(() => loadAiAgentOpenAiConfig(path)).toThrow();
  });

  test("文件存在但内容为空", () => {
    // 用户先 touch 出占位文件、还没来得及填内容时就是这个状态。
    const path: string = writeConfig("");
    expect(() => loadAdDetectOpenAiConfig(path)).toThrow();
    expect(() => loadAiAgentOpenAiConfig(path)).toThrow();
  });
});

describe("单例缓存：成功与失败两侧都只解析一次", () => {
  afterEach(() => {
    adDetectOpenAiConfigCache.current = null;
    adDetectOpenAiConfigFailure.current = null;
    aiAgentOpenAiConfigCache.current = null;
    aiAgentOpenAiConfigFailure.current = null;
  });

  test("已缓存的解析失败直接重抛，不再碰盘", () => {
    // 广告检测的模型名是逐消息从这里取的（workers/antiRaid/adDetect/classifier.ts）。
    // 只缓存成功就意味着文件一坏，Anti-Raid Worker 的每条候选消息都要重做一次
    // 同步 readFileSync + JSON.parse 才抛进 catch——那条路上原本一次盘都不碰。
    const failure: Error = new Error("Invalid OpenAI config: boom");
    adDetectOpenAiConfigFailure.current = failure;

    expect(() => getAdDetectOpenAiConfig()).toThrow(failure);
    // 同一个实例，说明第二次没有重新解析出一个新 Error。
    expect(() => getAdDetectOpenAiConfig()).toThrow(failure);
  });

  test("成功值照旧缓存，且优先于失败 holder（两者互斥填充）", () => {
    const first: AdDetectOpenAiConfig = getAdDetectOpenAiConfig();
    expect(getAdDetectOpenAiConfig()).toBe(first);
    expect(adDetectOpenAiConfigFailure.current).toBeNull();
  });

  test("两段各持一对 holder：一段的失败态不会污染另一段", () => {
    // 回归守卫：共用一对 holder 时，ai_agent 的笔误会让广告检测在通过
    // adDetectConfigReadiness() 与启动 preflight 之后，于运行时永久静默失效。
    aiAgentOpenAiConfigFailure.current = new Error("Invalid OpenAI config: ai_agent must be an object");

    expect(() => getAdDetectOpenAiConfig()).not.toThrow();
    expect(adDetectOpenAiConfigCache.current).not.toBeNull();
    expect(adDetectOpenAiConfigFailure.current).toBeNull();

    // 反向同理。
    adDetectOpenAiConfigCache.current = null;
    aiAgentOpenAiConfigFailure.current = null;
    adDetectOpenAiConfigFailure.current = new Error("Invalid OpenAI config: ad_detect must be an object");

    expect(() => getAiAgentOpenAiConfig()).not.toThrow();
    expect(aiAgentOpenAiConfigCache.current).not.toBeNull();
    expect(aiAgentOpenAiConfigFailure.current).toBeNull();
  });
});
