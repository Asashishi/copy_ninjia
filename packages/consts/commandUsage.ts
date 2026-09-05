/** 禁言命令的固定用法提示，校验失败时统一发送。 */
export const MUTE_USAGE_TEXT: string =
  `笨蛋，/mute 后面要带时长：数字加 m/h/d，比如 10m、2h、1d（1 分钟~365 天）；` +
  `回复 TA 的消息发 /mute 10m，或者 /mute @username 10m、/mute 用户id 10m♡`;

/** 口塞命令的固定用法提示，校验失败时统一发送。 */
export const GAG_USAGE_TEXT: string =
  "哈？连怎么给杂鱼戴东西都不会吗♡ 用法是 /gag <@username|用户/频道id> [5|10|15] [用具]；" +
  "回复目标消息时只写 /gag [5|10|15] [用具] 就行，" +
  "没写时长就罚 5 分钟，没写用具就赏个口塞，记住了吗，笨蛋♡";

/** 批量踢人命令的固定用法提示，校验失败时统一发送。 */
export const BATCH_KICK_USAGE_TEXT: string =
  "笨蛋，/batch_kick 后面只带一个回溯时长：数字加 m/h/d，比如 30m、2h、1d；" +
  "最多回溯滚动 24 小时。这个命令只踢人，不会加入黑名单♡";
