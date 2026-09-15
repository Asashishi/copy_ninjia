/** 禁言命令的固定用法提示，校验失败时统一发送。 */
export const MUTE_USAGE_TEXT: string =
  "/mute 后必须带时长：数字加 m/h/d，例如 10m、2h、1d（1 分钟~365 天）。回复目标消息发送 /mute 10m，或使用 /mute @username 10m、/mute 用户id 10m。";

/** 口塞命令的固定用法提示，校验失败时统一发送。 */
export const GAG_USAGE_TEXT: string =
  "用法：/gag <@username|用户/频道id> [5|10|15] [用具]；回复目标消息时使用 /gag [5|10|15] [用具]。默认时长 5 分钟，默认用具为口塞。";

/** 批量踢人命令的固定用法提示，校验失败时统一发送。 */
export const BATCH_KICK_USAGE_TEXT: string =
  "/batch_kick 后仅接受一个回溯时长：数字加 m/h/d，例如 30m、2h、1d；最多回溯滚动 24 小时。只踢出成员，不加入黑名单。";

/** /copy stop 携带多余参数时的固定用法提示。 */
export const COPY_USAGE_TEXT: string =
  "回复目标消息后使用 /copy、/copy reverse（倒序）或 /copy nya（加喵~），也可在命令后加 @username 指定目标。停止请使用 /copy stop，stop 后不带参数。";

/** /qa 参数不合法时的用法提示。 */
export const QA_USAGE_TEXT: string =
  "使用 /qa set 打开登记表单，/qa remove <问题文本> 删除，/qa query [问题文本] 查询；query 不带问题时列出全部问答。";

/** /mood 只接受 query 或 switch，所有用法提示走统一命令消息清理。 */
export const MOOD_USAGE_TEXT: string =
  "使用 /mood query 查看本群当前心情，/mood switch 重新抽取心情；不接受其他参数。";

/** /clear_context 不接受任何参数。 */
export const CLEAR_CONTEXT_USAGE_TEXT: string =
  "/clear_context 不接受参数；执行后清空本群内存和数据库中的 AI 上下文。";

/** /icon 的用法提示。 */
export const ICON_USAGE_TEXT: string =
  "回复目标消息后使用 /icon steal，或使用 /icon steal @username 获取目标头像。恢复默认头像请使用 /icon reset，reset 后不带参数。";
