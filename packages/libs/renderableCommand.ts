import { RENDERABLE_COMMAND_PATTERN, RENDERABLE_COMMAND_NEUTRALIZE_PATTERN, NEUTRALIZED_SOLIDUS } from "../consts/renderableCommand";

/**
 * 判定的对象必须是**真正发出去的那一串**，不是它的上游原文：任何在判定之后
 * 还会改写文本的步骤（复读的模式变换、AI 的错字替换）都能把一个不含命令的串
 * 变成含命令的串，守卫和被守卫的值不是同一个字符串就等于没守。
 */
export function containsRenderableCommand(text: string): boolean {
  return RENDERABLE_COMMAND_PATTERN.test(text);
}

/**
 * 把一段**用户可控片段**里会被渲染成命令的 `/` 换成全角斜杠。
 *
 * 与 containsRenderableCommand 的分工是「这条消息由谁构成」：复读和 AI 回复的
 * 整条正文都由外部内容决定，那里只能整条判定、命中就不发；而命令回执是机器人
 * 自己写的句子，只有昵称、参数回显这些**片段**是用户可控的——在那里整条判定
 * 会把机器人自己文案里的 `/unquiet`、`/batch_kick`、`/x` 用法提示一并毙掉，所以
 * 那些路径改为在片段边界上中和，机器人自己写的命令名照常可点。
 *
 * 中和而不是整段丢弃：昵称与参数回显都要让人认出是谁、写错了什么，抹掉等于
 * 让提示答非所问。
 *
 * 不含可渲染命令的串原样返回（同一个字符串对象，不重建）。
 */
export function neutralizeRenderableCommands(text: string): string {
  // 绝大多数昵称与参数根本没有斜杠；先用一次 indexOf 挡掉正则与字符串重建。
  if (!text.includes("/")) return text;
  return text.replace(RENDERABLE_COMMAND_NEUTRALIZE_PATTERN, `$1${NEUTRALIZED_SOLIDUS}`);
}
