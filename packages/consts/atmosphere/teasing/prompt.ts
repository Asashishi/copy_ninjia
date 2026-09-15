/** /prompt 的用法、鉴权、接管状态和 durable 操作回执，统一延迟清理。 */
export const PROMPT_COMMAND_TEXTS: Readonly<{
  usage: string; rejected: string; notInitialized: string; configured: string; removed: string;
}> = {
  usage: "笨蛋，想给本天才换人设就用 /prompt config <提示词>，腻了就 /prompt remove 换回默认人设，连这都要教吗♡",
  rejected: "哈？就你也想改本天才的 AI 提示词？没这项权限就别伸手，杂鱼♡",
  notInitialized: "这个群本天才还没接管呢，先让超级管理员 /init enable 再来使唤本天才，杂鱼♡",
  configured: "哼，本群 AI 人设本天才记下啦，从下一轮回复开始生效，可别后悔哦杂鱼♡",
  removed: "本群自定义 AI 人设扔掉啦，下一轮回复换回默认人设——还是原装的本天才最好吧，杂鱼♡",
};
