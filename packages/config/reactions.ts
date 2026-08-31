import { TELEGRAM_REACTION_EMOJI_SET } from "../consts/reactions";
import { defaultReactionConfigCache } from "../cache/perThread/config";
import { REACTIONS_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isPlainRecord } from "../libs/record";
import { isNonEmptyStringArray } from "../libs/runtimeConfig";
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
export async function loadReactionConfig(
  path: string = REACTIONS_CONFIG_PATH
): Promise<ReactionConfig> {
  return parseReactionConfig(await readJsonInput(path), path);
}

/** 接管启动预检或 Worker 初始化消息已经严格校验的反应配置快照。 */
export function adoptReactionConfig(config: ReactionConfig): void {
  defaultReactionConfigCache.current = config;
}

/** 启动预检填充默认路径快照；重复调用只读 holder。 */
export async function ensureReactionConfig(): Promise<void> {
  if (defaultReactionConfigCache.current !== null) return;
  adoptReactionConfig(await loadReactionConfig());
}

/** 默认反应配置只读当前线程已校验的快照，不在运行期回退读盘。 */
export function getReactionConfig(): ReactionConfig {
  const config: ReactionConfig | null = defaultReactionConfigCache.current;
  if (config === null) {
    throw new Error(`Reaction configuration was not initialized from ${REACTIONS_CONFIG_PATH}.`);
  }
  return config;
}
