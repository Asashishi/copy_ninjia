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

/** /copy stop 携带多余参数时的固定用法提示；群内由统一命令消息边界清理。 */
export const COPY_USAGE_TEXT: string =
  "笨蛋，回复目标消息后用 /copy、/copy reverse（倒序）或 /copy nya（加喵~），也可以在后面加 @username 指定目标；停止用 /copy stop，stop 后面别加参数♡";

/** /qa 参数不合法时的用法提示；表单内容通过后续消息填写。 */
export const QA_USAGE_TEXT: string =
  "笨蛋，用 /qa set 开表单登记问答，/qa remove <问题文本> 删除，/qa query [问题文本] 查询；query 不带问题时列出全部♡";

/** /mood 只接受 query 或 switch，所有用法提示走统一命令消息清理。 */
export const MOOD_USAGE_TEXT: string =
  "笨蛋，用 /mood query 看本群当前心情，/mood switch 重新抽取心情，后面别加其它参数♡";

/** /icon 的用法提示；steal 接受目标，reset 不接受额外参数。 */
export const ICON_USAGE_TEXT: string =
  "笨蛋，回复目标消息后用 /icon steal，或 /icon steal @username 偷头像；恢复默认头像用 /icon reset，reset 后面别加参数♡";
