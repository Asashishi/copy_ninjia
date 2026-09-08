/** 复读文本变换（packages/copy/copyModes.ts）的常量。 */

/** /copy 的子命令结构；只剥离完整的 stop、reverse 或 nya，目标参数交给共享身份解析器。 */
export const COPY_SUBCOMMAND_PATTERN: RegExp = /^(stop|reverse|nya)(?:\s+([\s\S]+))?$/u;

/** /copy nya 给纯文本追加的后缀（已以它结尾的文本不重复追加）。 */
export const NYA_SUFFIX: string = "喵~";
