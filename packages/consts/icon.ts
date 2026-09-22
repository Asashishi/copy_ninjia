/**
 * /icon 子命令结构；steal 后的目标交给共享身份解析器，reset 不接受目标。
 * 子命令词不区分大小写（口径同 `/block`、`/white`、`/init`、`/prompt`）；捕获组
 * 保留原样大小写，调用方取值时自己 `toLowerCase()` 再比较。
 */
export const ICON_SUBCOMMAND_PATTERN: RegExp = /^(steal|reset)(?:\s+([\s\S]+))?$/iu;
