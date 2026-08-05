/**
 * config/gemini.json 的解析：**整份必填、四个模型名一个都不能少**。
 *
 * 与 openai.json 的关键差别有两处，都要守住：
 * 1. 没有 base_url——Gemini 走官方 SDK，端点不可配。多写一个键必须报错，否则
 *    运维会以为自己换了端点、实际半点没变。
 * 2. 缺文件直接抛错。这份配置从来没有默认值可退，代码里一个 Gemini 模型名都
 *    不留。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGeminiDeploymentConfig,
  loadGeminiDeploymentConfig,
  parseGeminiDeploymentConfig,
} from "../../packages/config/gemini";
import {
  geminiDeploymentConfigCache,
  geminiDeploymentConfigFailure,
} from "../../packages/cache/perThread/config";
import type { GeminiDeploymentConfig } from "../../packages/types/config";

const MODELS = { reply: "r", summary: "s", media: "m", image: "i" } as const;

/** 把一份 JSON 写进临时目录，返回路径。 */
function writeConfig(content: string): string {
  const dir: string = mkdtempSync(join(tmpdir(), "gemini-config-test-"));
  const path: string = join(dir, "gemini.json");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("完整配置逐字段生效", () => {
  test("四个模型名原样读回", () => {
    expect(parseGeminiDeploymentConfig({ models: MODELS })).toEqual({ models: MODELS });
  });

  test("从文件读出的值与写进去的一致", () => {
    const path: string = writeConfig(JSON.stringify({ models: MODELS }));
    expect(loadGeminiDeploymentConfig(path)).toEqual({ models: MODELS });
  });

  test("模型名两端空白被去掉", () => {
    const parsed: GeminiDeploymentConfig = parseGeminiDeploymentConfig({
      models: { ...MODELS, reply: "  gemini-x  " },
    });
    expect(parsed.models.reply).toBe("gemini-x");
  });
});

describe("缺省一律拒绝：代码里没有默认模型可退", () => {
  test("缺文件直接抛错", () => {
    expect(() => loadGeminiDeploymentConfig(join(tmpdir(), "definitely-absent-gemini.json"))).toThrow();
  });

  test("整份缺 models", () => {
    expect(() => parseGeminiDeploymentConfig({})).toThrow(/models must be an object/);
  });

  test("四档缺任意一档都拒绝", () => {
    for (const missing of ["reply", "summary", "media", "image"] as const) {
      const models: Record<string, string> = { ...MODELS };
      delete models[missing];
      expect(() => parseGeminiDeploymentConfig({ models }))
        .toThrow(new RegExp(`models\\.${missing} must be a non-empty string`));
    }
  });

  test("空串与非字符串模型名", () => {
    expect(() => parseGeminiDeploymentConfig({ models: { ...MODELS, media: "   " } }))
      .toThrow(/models\.media must be a non-empty string/);
    expect(() => parseGeminiDeploymentConfig({ models: { ...MODELS, image: 42 } }))
      .toThrow(/models\.image must be a non-empty string/);
  });
});

describe("写坏一律抛错", () => {
  test("顶层不是对象", () => {
    expect(() => parseGeminiDeploymentConfig([])).toThrow(/expected an object/);
    expect(() => parseGeminiDeploymentConfig("x")).toThrow(/expected an object/);
    expect(() => parseGeminiDeploymentConfig(null)).toThrow(/expected an object/);
  });

  test("顶层未知键——base_url 是最可能被误加的那个", () => {
    // Gemini 端点由官方 SDK 管；静默忽略它会让运维以为自己换了端点。
    expect(() => parseGeminiDeploymentConfig({ models: MODELS, base_url: "https://x.example" }))
      .toThrow(/expected an object with only \{ models \}/);
  });

  test("models 内未知键——拼错的键被无声忽略最危险", () => {
    expect(() => parseGeminiDeploymentConfig({ models: { ...MODELS, replies: "x" } }))
      .toThrow(/models must be an object with only/);
  });

  test("文件存在但不是合法 JSON / 内容为空", () => {
    expect(() => loadGeminiDeploymentConfig(writeConfig("{ nope"))).toThrow();
    expect(() => loadGeminiDeploymentConfig(writeConfig(""))).toThrow();
  });
});

describe("单例缓存：成功与失败两侧都只解析一次", () => {
  afterEach(() => {
    geminiDeploymentConfigCache.current = null;
    geminiDeploymentConfigFailure.current = null;
  });

  test("成功结果被缓存，重复取用是同一个对象", () => {
    geminiDeploymentConfigCache.current = null;
    geminiDeploymentConfigFailure.current = null;
    const first: GeminiDeploymentConfig = getGeminiDeploymentConfig();
    expect(getGeminiDeploymentConfig()).toBe(first);
    expect(geminiDeploymentConfigFailure.current).toBeNull();
  });

  test("失败也缓存：坏文件在同一条线程上不会被反复读盘解析", () => {
    // 回复会话每轮都要取一次模型名，只缓存成功就等于每轮一次同步 readFileSync。
    const failure: Error = new Error("Invalid Gemini config: boom");
    geminiDeploymentConfigCache.current = null;
    geminiDeploymentConfigFailure.current = failure;
    expect(() => getGeminiDeploymentConfig()).toThrow(failure);
    expect(() => getGeminiDeploymentConfig()).toThrow(failure);
  });
});
