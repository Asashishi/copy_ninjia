/** /icon 子命令结构；steal 后的目标交给共享身份解析器，reset 不接受目标。 */
export const ICON_SUBCOMMAND_PATTERN: RegExp = /^(steal|reset)(?:\s+([\s\S]+))?$/u;
