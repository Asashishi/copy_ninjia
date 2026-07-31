/** 入群验证文案、时限与短期去重窗口。 */

/** 验证按钮上显示的文案，新成员必须在 VERIFICATION_TIMEOUT_MS 内点击，否则会被踢出。 */
export const VERIFICATION_BUTTON_TEXT: string = "我是新人，别搞！";
/** 验证按钮 callback_data 的前缀，后面拼上待验证成员的 userId。 */
export const VERIFY_CALLBACK_PREFIX: string = "verify:";
/** 新成员完成验证的完整时间窗口。 */
export const VERIFICATION_TIMEOUT_MS: number = 3 * 60_000;
/** 验证提醒投递失败后的指数退避边界；失败期间成员不会因看不到按钮被踢。 */
export const VERIFICATION_REMINDER_RETRY_INITIAL_MS: number = 1_000;
/** 验证提醒指数退避允许增长到的最大间隔。 */
export const VERIFICATION_REMINDER_RETRY_MAX_MS: number = 15_000;
/**
 * 「一条带按钮的提醒都没发出去」这种情形下，验证窗口最多能被连续续期到入群后
 * 多久为止。
 *
 * 续期本身是对的：没人看得见按钮就不能把「没点」解释成拒绝验证。但它不能没有
 * 尽头——某个群 sendMessage 持续失败（论坛的 General 话题被关闭、机器人被禁言
 * 却仍保有限制成员的权限）时，每个入群者都会留下一条不朽记录：常驻待验证表、
 * 常驻主线程镜像、持续刷新 memory/anti-raid/<day>.json。超过这个总时长就按
 * 普通超时结算：踢人只踢不封
 * （kickChatMember），人随时可以重进，而那时群本身多半已经不正常了。
 * 所属模块：states/verification.ts 的 handleVerifyTimeout。
 */
export const VERIFICATION_REMINDER_UNDELIVERED_MAX_MS: number = 15 * 60 * 1000;
/** 终态踢人失败后的**首次**重试间隔；记录保持持久化，不能把未处置成员当作已完成。 */
export const VERIFICATION_TERMINAL_RETRY_MS: number = 30 * 1000;
/**
 * 终态重试指数退避的上限。
 *
 * 有些失败注定不会好转：机器人是管理员却没有封禁权限，或目标本人就是这个群的
 * 管理员。记录按设计不能删，于是固定 30 秒一轮就意味着——一次刷群留下的**每个**
 * 未验证成员各占一个永久的 30 秒循环，各自不停打成员探测 + kickChatMember，
 * 并往 logs/ 里刷同一行报错，Worker 重建和进程重启后还会照单重新武装。
 * 退避到上限而不是放弃：管理员补上封禁权限后，最迟一个上限周期内自愈。
 * 所属模块：workers/antiRaid/verificationEffects.ts。
 */
export const VERIFICATION_TERMINAL_RETRY_MAX_MS: number = 30 * 60 * 1000;
/**
 * 私密模式下直接踢人的占位记录存活时长：只是给 chat_member 更新和
 * new_chat_members 服务消息（针对同一次入群各自触发）留出去重窗口，
 * 不是真的验证超时，所以远比 VERIFICATION_TIMEOUT_MS 短。
 */
export const LOCKDOWN_KICK_DEDUPE_MS: number = 30 * 1000;
/**
 * 私密模式秒踢占位遇到新 join 事件时，用来判断“这是同一次物理入群的另一条
 * 投递（chat_member 更新 + 服务消息，间隔实测毫秒级）”还是“TA 真的重新
 * 申请了入群”（kickChatMember 只踢不封，本就能立刻重进）的分界线。
 * 远小于 LOCKDOWN_KICK_DEDUPE_MS——那个是占位整体存活时长，这个只区分
 * 同一次入群的两条腿，见 states/verification.ts 的 handleJoin。
 */
export const KICKED_REJOIN_GRACE_MS: number = 5 * 1000;
/** 验证通过后的欢迎消息在被自动清理前保持可见的时长。 */
export const WELCOME_AUTO_DELETE_MS: number = 30 * 1000;
/** 终结 revision 为抵御重复 adopt 保留的时间；之后周期清理，避免按历史成员增长。 */
export const VERIFICATION_REVISION_RETENTION_MS: number = 10 * 60 * 1000;
