import { RENDERABLE_COMMAND_PATTERN, RENDERABLE_COMMAND_NEUTRALIZE_PATTERN, NEUTRALIZED_SOLIDUS } from "../consts/renderableCommand";

/**
 * 判定的对象是真正发出去的那一串，不是它的上游原文；复读的模式变换、AI 的错字替换
 * 等改写文本的步骤必须在判定之前完成。
 */
export function containsRenderableCommand(text: string): boolean {
  return RENDERABLE_COMMAND_PATTERN.test(text);
}

/**
 * 把一段用户可控片段里会被渲染成命令的 `/` 换成全角斜杠，其余字符保留。
 *
 * 与 containsRenderableCommand 的分工按消息构成区分：复读和 AI 回复的整条正文都由
 * 外部内容决定，整条判定、命中就不发；命令回执是机器人自己写的句子，只有昵称、
 * 参数回显这些片段由用户控制，在片段边界上中和，机器人自己写的命令名保持可点。
 *
 * 不含可渲染命令的串原样返回（同一个字符串对象，不重建）。
 */
export function neutralizeRenderableCommands(text: string): string {
  // 不含斜杠时跳过正则与字符串重建。
  if (!text.includes("/")) return text;
  return text.replace(RENDERABLE_COMMAND_NEUTRALIZE_PATTERN, `$1${NEUTRALIZED_SOLIDUS}`);
}
