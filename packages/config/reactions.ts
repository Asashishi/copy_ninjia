import { readFileSync } from "node:fs";
import { TELEGRAM_REACTION_EMOJI_SET } from "../consts/reactions";
import { defaultReactionConfigCache } from "../cache/perThread/config";
import { REACTIONS_CONFIG_PATH } from "../consts/paths";
import type { ReactionEmoji } from "../consts/reactions";
import { hasExactKeys, isNonEmptyStringArray, isPlainRecord } from "../libs/runtimeConfig";

export type { ReactionEmoji } from "../consts/reactions";

export interface ReactionConfig {
  readonly emotionKeywords: Readonly<Partial<Record<ReactionEmoji, readonly string[]>>>;
}

/** 严格解码 reactions.json；非法 Telegram 标准反应在启动阶段直接报错。 */
export function parseReactionConfig(value: unknown): ReactionConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["emotionKeywords"]) || !isPlainRecord(value.emotionKeywords)) {
    throw new Error("Invalid reactions config: expected exactly { emotionKeywords: Record<string, string[]> }");
  }

  const emotionKeywords: Partial<Record<ReactionEmoji, readonly string[]>> = Object.create(null) as Partial<Record<ReactionEmoji, readonly string[]>>;
  for (const [emoji, keywords] of Object.entries(value.emotionKeywords)) {
    if (!TELEGRAM_REACTION_EMOJI_SET.has(emoji)) {
      throw new Error(`Unsupported Telegram reaction emoji in reactions config: ${JSON.stringify(emoji)}`);
    }
    if (!isNonEmptyStringArray(keywords)) {
      throw new Error(`Invalid reactions config entry for ${JSON.stringify(emoji)}`);
    }
    emotionKeywords[emoji as ReactionEmoji] = Object.freeze([...keywords]);
  }
  return Object.freeze({ emotionKeywords: Object.freeze(emotionKeywords) });
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadReactionConfig(path: string = REACTIONS_CONFIG_PATH): ReactionConfig {
  return parseReactionConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** 默认部署配置按进程/Worker 惰性加载一次。主进程会在取得实例锁后预先调用。 */
export function getReactionConfig(): ReactionConfig {
  defaultReactionConfigCache.current ??= loadReactionConfig();
  return defaultReactionConfigCache.current;
}
