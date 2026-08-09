import { defaultAdSampleConfigCache } from "../cache/perThread/config";
import { AD_SAMPLE_MAX_CHARS, MAX_CONFIGURED_AD_SAMPLES } from "../consts/antiRaid/adDetect";
import { AD_SAMPLES_CONFIG_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import type { AdSampleConfig } from "../types/config";

/** 严格解码 ad_samples.json：顶层必须是字符串数组，拒绝空串、超长与重复。 */
export function parseAdSampleConfig(
  value: unknown,
  sourcePath: string = AD_SAMPLES_CONFIG_PATH
): AdSampleConfig {
  if (!Array.isArray(value)) {
    return invalidInput(sourcePath, "$", "a string array");
  }
  if (value.length > MAX_CONFIGURED_AD_SAMPLES) {
    return invalidInput(sourcePath, "$", `an array with at most ${MAX_CONFIGURED_AD_SAMPLES} entries`);
  }

  const samples: string[] = [];
  const seen: Set<string> = new Set();
  for (let index: number = 0; index < value.length; index++) {
    const sample: unknown = value[index];
    if (typeof sample !== "string") {
      return invalidInput(sourcePath, `$[${index}]`, "a non-empty string");
    }
    // 提示词按行拼装，示例里的换行会把一条示例撕成看起来彼此无关的几条；
    // 统一压成单行后再判空/判重，空白差异也就不会伪装成两条不同的示例。
    const normalized: string = sample.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
      return invalidInput(sourcePath, `$[${index}]`, "a non-empty string");
    }
    if (normalized.length > AD_SAMPLE_MAX_CHARS) {
      return invalidInput(sourcePath, `$[${index}]`, `a string no longer than ${AD_SAMPLE_MAX_CHARS} characters`);
    }
    if (seen.has(normalized)) {
      return invalidInput(sourcePath, `$[${index}]`, "unique after whitespace normalization");
    }
    seen.add(normalized);
    samples.push(normalized);
  }
  return samples;
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadAdSampleConfig(path: string = AD_SAMPLES_CONFIG_PATH): AdSampleConfig {
  return parseAdSampleConfig(readJsonInput(path), path);
}

/**
 * 默认部署配置按进程/Worker 惰性缓存。主进程启动总闸会校验已存在的文件；
 * 真正缺省时仍由功能 readiness 决定该功能能否开启。
 */
export function getAdSampleConfig(): AdSampleConfig {
  defaultAdSampleConfigCache.current ??= loadAdSampleConfig();
  return defaultAdSampleConfigCache.current;
}
