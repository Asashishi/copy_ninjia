import { readFileSync } from "node:fs";
import { TELEGRAM_REACTION_EMOJI_SET } from "../consts/reactions";
import { defaultReactionConfigCache } from "../cache/perThread/config";
import { REACTIONS_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isNonEmptyStringArray, isPlainRecord } from "../libs/runtimeConfig";
import type { ReactionConfig, ReactionEmoji } from "../types/config";

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
    emotionKeywords[emoji as ReactionEmoji] = [...keywords];
  }
  return { emotionKeywords };
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadReactionConfig(path: string = REACTIONS_CONFIG_PATH): ReactionConfig {
  return parseReactionConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * 默认部署配置按进程/Worker 惰性加载一次。**主进程不得在启动阶段统一预热**
 * （见 docs/04-invariants.md 与 app/lifecycle.ts 的说明）：这些都是按群 opt-in
 * 的可选功能配置，一份写坏的文件在启动阶段抛出，会连带 copy、抽奖、入群验证、
 * 黑名单一起离线，systemd 还会照着重启循环。校验归各功能自己的 enable 分支
 * （config/readiness.ts 与 commands/configGate.ts），坏了只拒绝那一个功能。
 */
export function getReactionConfig(): ReactionConfig {
  defaultReactionConfigCache.current ??= loadReactionConfig();
  return defaultReactionConfigCache.current;
}
