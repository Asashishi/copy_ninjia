/** 发送正文中可渲染为 Telegram 命令的匹配规则。 */
export const RENDERABLE_COMMAND_PATTERN: RegExp = /(?:^|[^A-Za-z0-9_/])\/[A-Za-z0-9_]/;

/** 发送正文中需中和的命令斜杠，全局匹配且保留前缀。 */
export const RENDERABLE_COMMAND_NEUTRALIZE_PATTERN: RegExp = /(^|[^A-Za-z0-9_/])\/(?=[A-Za-z0-9_])/g;

/** 命令中和使用的全角斜杠，不改变其后的正文。 */
export const NEUTRALIZED_SOLIDUS: string = "\uff0f";
