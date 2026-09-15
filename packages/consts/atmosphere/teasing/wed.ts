/** /wed 单排按钮文字，确认后仍允许更换。 */
export const WED_BUTTON_TEXTS: Readonly<{
  remove: string;
  marry: string;
  confirmed: string;
  change: string;
}> = { remove: "移除", marry: "娶老婆!", confirmed: "已确认♡", change: "换一只" };

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
  groupOnly: "频道怎么娶老婆呀，用个人身份在群里发送 /wed 啦。",
  usage: "连抽老婆都不会呀，杂鱼♡ 直接发送 /wed 就好，后面不用加东西啦。",
  busy: "本天才正在帮你抽呢，急着娶老婆也要乖乖等一下，杂鱼♡",
  full: "本群的抽取会话已经塞满啦，先移除不需要的结果再来，贪心的杂鱼♡",
  queueFull: "抽老婆的队伍都排满啦，杂鱼乖乖等会儿再来♡",
  empty: "连其他可抽的群友都没有，杂鱼也太心急啦♡ 等大家发言后再来。",
  unavailable: "这次没找到头像可用的群友哦♡ 运气真差呢，杂鱼稍后再抽啦。",
  expired: "这条抽取早就结束啦，还戳呀，笨蛋♡ 重新发送 /wed 再来。",
  updated: "老婆都换过啦，还惦记旧按钮呢，杂鱼♡ 用这条消息上的最新按钮啦。",
  ownerOnly: "别乱碰别人的老婆啦，杂鱼♡ 只有发起人能操作，想要就自己发 /wed。",
  failed: "这次操作没完成啦，杂鱼先别急，稍后再试一次♡",
  confirmed: "好啦，就认定这位群友老婆了♡ 杂鱼可要好好珍惜哦。",
};
