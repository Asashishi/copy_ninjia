import { readFileSync } from "node:fs";
import { defaultAdSampleConfigCache } from "../cache/perThread/config";
import { AD_SAMPLE_MAX_CHARS, MAX_CONFIGURED_AD_SAMPLES } from "../consts/antiRaid/adDetect";
import { AD_SAMPLES_CONFIG_PATH } from "../consts/paths";
import type { AdSampleConfig } from "../types/config";

/** 严格解码 ad_samples.json：顶层必须是字符串数组，拒绝空串、超长与重复。 */
export function parseAdSampleConfig(value: unknown): AdSampleConfig {
  if (!Array.isArray(value)) {
    throw new Error("Invalid ad samples config: expected a string array");
  }
  if (value.length > MAX_CONFIGURED_AD_SAMPLES) {
    throw new Error(`Invalid ad samples config: at most ${MAX_CONFIGURED_AD_SAMPLES} samples are allowed`);
  }

  const samples: string[] = [];
  const seen: Set<string> = new Set();
  for (const sample of value) {
    if (typeof sample !== "string") {
      throw new Error(`Invalid ad samples config entry: ${JSON.stringify(sample)}`);
    }
    // 提示词按行拼装，示例里的换行会把一条示例撕成看起来彼此无关的几条；
    // 统一压成单行后再判空/判重，空白差异也就不会伪装成两条不同的示例。
    const normalized: string = sample.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
      throw new Error("Invalid ad samples config: entries must not be blank");
    }
    if (normalized.length > AD_SAMPLE_MAX_CHARS) {
      throw new Error(`Invalid ad samples config: entries must be at most ${AD_SAMPLE_MAX_CHARS} characters`);
    }
    if (seen.has(normalized)) throw new Error(`Duplicate ad samples config entry: ${normalized}`);
    seen.add(normalized);
    samples.push(normalized);
  }
  return samples;
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadAdSampleConfig(path: string = AD_SAMPLES_CONFIG_PATH): AdSampleConfig {
  return parseAdSampleConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * 默认部署配置按进程/Worker 惰性加载一次。**主进程不得在启动阶段统一预热**
 * （见 docs/04-invariants.md 与 app/lifecycle.ts 的说明）：这些都是按群 opt-in
 * 的可选功能配置，一份写坏的文件在启动阶段抛出，会连带 copy、抽奖、入群验证、
 * 黑名单一起离线，systemd 还会照着重启循环。校验归各功能自己的 enable 分支
 * （config/readiness.ts 与 commands/configGate.ts），坏了只拒绝那一个功能。
 */
export function getAdSampleConfig(): AdSampleConfig {
  defaultAdSampleConfigCache.current ??= loadAdSampleConfig();
  return defaultAdSampleConfigCache.current;
}
