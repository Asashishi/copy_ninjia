import { COMMAND_ARGUMENT_SEPARATOR_PATTERN } from "../consts/commands";
import type { ToggleAction } from "../types/commands";

/**
 * 命令参数的统一分词。
 *
 * `/mute`、`/white`、`/block`、`/permission`、`/batch_kick` 与开关类命令都要把 `ctx.match`
 * 拆成位置参数或动作，口径必须一致，收在这一处。
 */

/**
 * 把命令参数原文拆成非空 token，保持原有相对顺序。
 *
 * `trim` 之后仍要滤掉空串：`"".split(/\s+/)` 的结果是 `[""]` 而不是 `[]`，少这一步
 * 空参数就会变成「有一个空 token」，调用方按 `tokens.length` 分派子命令时会走进
 * 一条本该报用法的分支。
 * @param match grammY 给出的命令参数原文（`ctx.match`），可以是空串。
 */
export function commandArgumentTokens(match: string): string[] {
  return match
    .trim()
    .split(COMMAND_ARGUMENT_SEPARATOR_PATTERN)
    .filter((token: string): boolean => token.length > 0);
}

/** splitTrailingToken 的结果：末位 token 与它前面的整段参数。 */
export interface TrailingTokenSplit {
  /** 末位 token；没有参数时为 undefined。 */
  readonly last: string | undefined;
  /** 末位之前的 token 以单个空格重新拼接；只有一个或没有参数时为空串。 */
  readonly rest: string;
}

/**
 * 按「目标参数 + 末位动作或时长」的口径拆分命令参数（`/block`、`/white` 与 `/mute` 共用）；
 * 分词同 commandArgumentTokens。
 */
export function splitTrailingToken(match: string): TrailingTokenSplit {
  const tokens: string[] = commandArgumentTokens(match);
  return { last: tokens.at(-1), rest: tokens.slice(0, -1).join(" ") };
}

/** 大小写不敏感地解析 enable/disable 动作，拒绝其它近似写法。 */
export function parseToggleAction(raw: string): ToggleAction | undefined {
  const normalized: string = raw.toLowerCase();
  if (normalized === "enable" || normalized === "disable") return normalized;
  return undefined;
}
