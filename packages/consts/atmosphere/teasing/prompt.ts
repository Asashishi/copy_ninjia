/** /prompt 的用法、鉴权、接管状态和 durable 操作回执，统一延迟清理。 */
export const PROMPT_COMMAND_TEXTS: Readonly<{
  usage: string; rejected: string; notInitialized: string; configured: string; removed: string;
}> = {
  usage: "用 /prompt config <提示词> 配置本群 AI 人设，或用 /prompt remove 恢复默认人设♡",
  rejected: "你没有配置本群 AI 提示词的权限哦♡",
  notInitialized: "先让超级管理员用 /init enable 接管本群哦♡",
  configured: "本群 AI 人设已保存，从下一轮回复开始生效♡",
  removed: "本群自定义 AI 人设已移除，下一轮回复使用默认人设♡",
};
