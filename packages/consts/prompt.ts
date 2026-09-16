/** /prompt 唯一参数语法，允许提示词保留正文内部的空白与换行。 */
export const PROMPT_COMMAND_PATTERN: RegExp = /^(config)(?:\s+([\s\S]+))?$|^(remove)$/i;
