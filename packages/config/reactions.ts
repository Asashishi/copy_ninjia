import { TELEGRAM_REACTION_EMOJI_SET } from "../consts/reactions";
import { defaultReactionConfigCache } from "../cache/perThread/config";
import { REACTIONS_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isNonEmptyStringArray, isPlainRecord } from "../libs/runtimeConfig";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import type { ReactionConfig, ReactionEmoji } from "../types/config";

/** 严格解码 reactions.json；非法 Telegram 标准反应在启动阶段直接报错。 */
export function parseReactionConfig(
  value: unknown,
  sourcePath: string = REACTIONS_CONFIG_PATH
): ReactionConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["emotionKeywords"]) || !isPlainRecord(value.emotionKeywords)) {
    return invalidInput(sourcePath, "$", "exactly { emotionKeywords: Record<ReactionEmoji, nonEmptyString[]> }");
  }

  const emotionKeywords: Partial<Record<ReactionEmoji, readonly string[]>> = Object.create(null) as Partial<Record<ReactionEmoji, readonly string[]>>;
  for (const [emoji, keywords] of Object.entries(value.emotionKeywords)) {
    if (!TELEGRAM_REACTION_EMOJI_SET.has(emoji)) {
      return invalidInput(sourcePath, "$.emotionKeywords.<key>", "a supported Telegram reaction emoji");
    }
    if (!isNonEmptyStringArray(keywords)) {
      return invalidInput(sourcePath, "$.emotionKeywords.<value>", "an array of non-empty strings");
    }
    emotionKeywords[emoji as ReactionEmoji] = [...keywords];
  }
  return { emotionKeywords };
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadReactionConfig(path: string = REACTIONS_CONFIG_PATH): ReactionConfig {
  return parseReactionConfig(readJsonInput(path), path);
}

/**
 * 默认部署配置按进程/Worker 惰性缓存。主进程启动总闸会校验已存在的文件；
 * 真正缺省时仍由功能 readiness 决定该功能能否开启。
 */
export function getReactionConfig(): ReactionConfig {
  defaultReactionConfigCache.current ??= loadReactionConfig();
  return defaultReactionConfigCache.current;
}
