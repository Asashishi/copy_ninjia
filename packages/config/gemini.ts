import { readFileSync } from "node:fs";
import { geminiDeploymentConfigCache, geminiDeploymentConfigFailure } from "../cache/perThread/config";
import { GEMINI_CONFIG_PATH } from "../consts/paths";
import { hasOnlyKeys, isPlainRecord } from "../libs/runtimeConfig";
import type { GeminiDeploymentConfig, GeminiModels } from "../types/config";

/**
 * config/gemini.json：Gemini 实现包四条流水线各自的模型名。
 *
 * **整份文件必填，四个模型名一个都不能少。** 代码里不再保留任何模型默认值——
 * 有默认值就意味着「配错了也能跑起来」，而跑起来之后两边产出都「看起来正常」，
 * 运维要到对账时才发现自己以为换掉的模型从没生效过。缺文件、缺字段一律抛错，
 * 由 config/readiness.ts 的探测把它变成「拒绝启动 / 拒绝开启功能」。
 *
 * 结构上比 config/openai.json 少一层 base_url：Gemini 走官方 SDK，端点不可配。
 * 这是刻意的结构差别，不是漏写。
 *
 * 密钥不在这里：`AI_CHAT_GEMINI_API_KEY` 仍是 env（见 infra/config.ts）。模型是
 * 「这次部署用哪个」的运维配置，密钥是凭据，两者的备份、权限与轮换节奏都不一样。
 */

/** 解码一个必填的模型名；缺了、空了、不是字符串都拒绝整份文件。 */
function requiredModel(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid Gemini config: ${context} must be a non-empty string`);
  }
  return value.trim();
}

/** 解码 models 对象；四项全部必填，未知键报错。 */
function parseModels(value: unknown): GeminiModels {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["reply", "summary", "media", "image"])) {
    throw new Error("Invalid Gemini config: models must be an object with only { reply, summary, media, image }");
  }
  return {
    reply: requiredModel(value.reply, "models.reply"),
    summary: requiredModel(value.summary, "models.summary"),
    media: requiredModel(value.media, "models.media"),
    image: requiredModel(value.image, "models.image"),
  };
}

/** 严格解码整份配置；顶层只认 models 一个必填对象。 */
export function parseGeminiDeploymentConfig(value: unknown): GeminiDeploymentConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["models"])) {
    throw new Error("Invalid Gemini config: expected an object with only { models }");
  }
  return { models: parseModels(value.models) };
}

/**
 * 从指定文件加载并校验整份配置；模块 import 本身不访问文件系统。
 *
 * 与 openai.ts 的对应函数有一处关键差别：**文件不存在照样抛错**。那边曾经把
 * ENOENT 当成「全部用默认值」，而这份文件根本没有默认值可退。
 */
export function loadGeminiDeploymentConfig(path: string = GEMINI_CONFIG_PATH): GeminiDeploymentConfig {
  return parseGeminiDeploymentConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * 默认部署配置按进程/Worker 惰性加载一次，成功与失败两侧都缓存。
 *
 * 只缓存成功是不够的：回复会话每轮都要取一次模型名，文件一坏就等于每轮一次
 * 同步 readFileSync + JSON.parse 才抛进 catch。抛出的是同一个 Error 实例，
 * 诊断文案不变。修好文件要重启才生效，与其余 loader 同一口径。
 */
export function getGeminiDeploymentConfig(): GeminiDeploymentConfig {
  if (geminiDeploymentConfigCache.current !== null) return geminiDeploymentConfigCache.current;
  if (geminiDeploymentConfigFailure.current !== null) throw geminiDeploymentConfigFailure.current;
  try {
    geminiDeploymentConfigCache.current = loadGeminiDeploymentConfig();
  } catch (error: unknown) {
    geminiDeploymentConfigFailure.current = error instanceof Error ? error : new Error(String(error));
    throw geminiDeploymentConfigFailure.current;
  }
  return geminiDeploymentConfigCache.current;
}
