/** /wed 单排按钮文字，确认后仍允许更换。 */
export const WED_BUTTON_TEXTS: Readonly<{
  remove: string;
  marry: string;
  confirmed: string;
  change: string;
}> = { "remove": "移除", "marry": "确认", "confirmed": "已确认", "change": "更换" };

/** /wed 校验和交互反馈。 */
export const WED_TEXTS: Readonly<{
  groupOnly: string;
  usage: string;
  busy: string;
  full: string;
  queueFull: string;
  empty: string;
  unavailable: string;
  expired: string;
  updated: string;
  ownerOnly: string;
  failed: string;
  confirmed: string;
}> = {
  "groupOnly": "请以个人身份在群里发送 /wed，频道身份无法使用。",
  "usage": "直接发送 /wed 即可，不接受额外参数。",
  "busy": "正在为你抽取，请稍等。",
  "full": "本群抽取会话已满，请先移除不需要的结果。",
  "queueFull": "抽取队列已满，请稍后再试。",
  "empty": "还没有其他可抽取的群友，请等成员发言后再试。",
  "unavailable": "本次未找到头像可用的群友，请稍后重新抽取。",
  "expired": "本次抽取已结束，请重新发送 /wed。",
  "updated": "结果已更换，请使用消息上的最新按钮。",
  "ownerOnly": "只有发起人可以操作此结果，请发送 /wed 开始自己的抽取。",
  "failed": "本次操作未完成，请稍后重试。",
  "confirmed": "已确认这位群友。",
};
