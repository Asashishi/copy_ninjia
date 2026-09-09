import { COMMAND_ARGUMENT_SEPARATOR_PATTERN } from "../consts/commands";

/**
 * 命令参数的统一分词。
 *
 * `/mute`、`/white`、`/permission` 与 `/batch_kick` 都要把 `ctx.match` 拆成位置
 * 参数，口径必须一致，收在这一处。
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
