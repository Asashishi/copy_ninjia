import type { ChatPermissions, MessageEntity } from "grammy/types";

/** Telegram API 封装（packages/infra/telegram/）的调参常量。 */

/** Telegram 部署示例中的 Bot token 占位值；生产严格解析必须拒绝。 */
export const TELEGRAM_BOT_TOKEN_PLACEHOLDER: string = "replace-with-telegram-bot-token";

/** Telegram update 里 `date` 字段（Unix 秒）换算成毫秒的倍数。 */
export const TELEGRAM_DATE_UNIT_MS: number = 1_000;

/** 长轮询订阅的完整 update 类型集合。 */
export const TELEGRAM_ALLOWED_UPDATES: readonly (
  | "message"
  | "channel_post"
  | "message_reaction"
  | "chat_member"
  | "my_chat_member"
  | "callback_query"
  | "inline_query"
  | "chosen_inline_result"
)[] = [
  "message",
  "channel_post",
  "message_reaction",
  "chat_member",
  "my_chat_member",
  "callback_query",
  "inline_query",
  "chosen_inline_result",
] as const;

/**
 * Bot API 服务端对重复 offset 的最短应答等待。
 *
 * 同一 offset 在上一次 getUpdates 开始后 3 秒内再次请求、且 `timeout` 小于 3 时，
 * 服务端把这次请求的 `timeout` 提到 3 秒（telegram-bot-api
 * `Client::process_get_updates_query`），期间没有新 update 就到点返回空数组。
 * 停机时的最终 offset 确认正是这种请求，其本地截止必须大于本值
 * （见 consts/lifecycle.ts 的 FINAL_OFFSET_CONFIRM_TIMEOUT_MS）。所属模块：app/lifecycle.ts。
 */
export const TELEGRAM_REPEATED_OFFSET_MIN_WAIT_MS: number = 3_000;

/** 抓取目标头像（Bot API / t.me 兜底）的单次请求超时。 */
export const AVATAR_FETCH_TIMEOUT_MS: number = 15_000;
/** 抓取目标头像允许的最大尝试次数。 */
export const AVATAR_FETCH_MAX_ATTEMPTS: number = 3;
/** 头像和公开主页分别采用独立硬上限，防止第三方响应导致无界内存占用。 */
export const AVATAR_MAX_DOWNLOAD_BYTES: number = 10 * 1024 * 1024;
/** 上传机器人头像时附带的文件名。Bot API 只按字节内容判格式，这个名字仅出现在
 *  multipart 的 filename 字段里；三条设置头像的路径共用同一个值，避免各写各的。 */
export const BOT_PROFILE_PHOTO_FILE_NAME: string = "avatar.jpg";

/** t.me 公开主页响应允许读入内存的最大字节数。 */
export const PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES: number = 1024 * 1024;
/**
 * t.me / telegram.me 公开主页允许返回头像资源的 Telegram 自有域。后缀由
 * packages/libs/httpUrlPolicy.ts 按 DNS label 边界匹配，不能用字符串包含
 * 判断；这里只限制轻量出站能力，不承担 DNS/IP 级 SSRF 防护。
 */
export const TELEGRAM_PUBLIC_ASSET_HOST_SUFFIXES: readonly string[] = [
  "t.me",
  "telegram.me",
  "telegram.org",
  "telegram-cdn.org",
  "cdn-telegram.org",
  "telesco.pe",
];
/** getUserProfilePhotos 单页最多能返回的张数，Bot API 本身的硬上限。 */
export const USER_PROFILE_PHOTOS_LIMIT: number = 100;

/** 踢人公告在被自动清理前保持可见的时长。 */
export const KICK_NOTICE_AUTO_DELETE_MS: number = 30 * 1000;

/**
 * 禁言一名成员时写给 `restrictChatMember` 的权限集：全部收走。
 *
 * 每一项都显式写出、不靠缺省：Bot API 对缺省字段确实按 false 处理，但这份
 * 常量同时是「禁言到底关掉了什么」的唯一说明，漏写一项在代码里看不出来，
 * 只能靠翻 Telegram 文档倒推。`can_react_to_messages` 尤其不能省——它缺省
 * 跟随 `can_send_messages`，写出来才看得见它也被关了。
 *
 * 全项为 false 时也不必带 `use_independent_chat_permissions`：那个标志只影响
 * 「某一项为 true 时会不会连带打开另几项」，这里没有任何一项为 true。
 */
export const MUTED_CHAT_PERMISSIONS: Readonly<ChatPermissions> = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_react_to_messages: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

/**
 * 解除禁言时写给 `restrictChatMember` 的权限集：全部放开。
 *
 * Bot API 对「解除限制」的说法就是把所有权限传 true——成员的实际权限仍与群
 * 默认权限取交集，所以这份全 true 不会赋予超出群设置的能力，只是把
 * MUTED_CHAT_PERMISSIONS 收走的那层个人限制整个摘掉。逐项显式写出的同
 * 上：这份常量也是「解除禁言到底恢复了什么」的唯一说明，必须与禁言集逐项
 * 对得上。全项为 true 时 `use_independent_chat_permissions` 同样不必带——
 * 联动打开的那几项本来就都要打开。
 */
export const UNMUTED_CHAT_PERMISSIONS: Readonly<ChatPermissions> = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_react_to_messages: true,
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_manage_topics: true,
};

/**
 * 读改写**群默认权限**（`setChatPermissions`）时固定带上的第三个参数。
 *
 * 与上面两份禁言常量相反，私密模式那条路是把 `getChat().permissions` 原样读
 * 回来、只改 `can_invite_users` 再写回去，里面**必然有为 true 的项**。Bot API
 * 对 `setChatPermissions` 的契约是：不传这个标志时 `can_send_other_messages`
 * 会连带蕴含 `can_send_messages`、`can_send_audios`、`can_send_documents`、
 * `can_send_photos`、`can_send_videos`、`can_send_video_notes` 与
 * `can_send_voice_notes`，`can_send_polls` 蕴含 `can_send_messages`。于是一个
 * 「只开表情/GIF、关掉图片视频文件」的群，每进出一次私密模式就会被静默地
 * 把媒体权限全部打开，管理员那边没有任何提示。带上它才是一次保真的读改写。
 *
 * 所属模块：packages/infra/telegram/lockdownPermissions.ts 与
 * packages/workers/antiRaid/lockdownRuntime.ts。
 */
export const INDEPENDENT_CHAT_PERMISSIONS_OTHER: Readonly<{
  use_independent_chat_permissions: true;
}> = {
  use_independent_chat_permissions: true,
};

/** Telegram 文本消息的硬性长度上限（字符），超出会被 Bot API 拒绝。 */
export const TELEGRAM_MESSAGE_MAX_CHARS: number = 4096;

/**
 * 媒体消息 caption 的硬性长度上限（字符），只有文本消息上限的四分之一，
 * 超出同样被 Bot API 直接拒绝而不是截断。Bot API 计的是 UTF-16 code unit，
 * 与 JS 的 `String.length` 同口径（代理对 emoji 各算 2），因此调用方直接用
 * `.length` 判定即可，不要换成 grapheme 或 code point 计数。
 */
export const TELEGRAM_CAPTION_MAX_CHARS: number = 1024;

/** Telegram 官方 Bot API 图片上传的字节上限（10 MB）；随机图片与 cron 本地图片按它判超限。 */
export const TELEGRAM_PHOTO_UPLOAD_MAX_BYTES: number = 10 * 1024 * 1024;

/**
 * `sendPhoto` 对宽高之和的硬性上限（官方 Bot API：width + height 必须 ≤ 10000）。
 *
 * 与字节上限并列的第二道门槛，且两者互不蕴含——一张 12000×40 的长条 PNG 只有
 * 几十 KB，照样发不出去。`/h_image add` 在收图时按它拒收（commands/hImage/add.ts），
 * 否则这张图会一直躺在图库里，直到某次 `/h_image` 或 cron `rand_image` 抽中它，
 * 才以一次 PHOTO_INVALID_DIMENSIONS 静默失败收场。
 */
export const TELEGRAM_PHOTO_MAX_DIMENSION_SUM: number = 10_000;

/**
 * `sendPhoto` 对长宽比的硬性上限（官方 Bot API：width / height 必须 ≤ 20，
 * 反过来同样）。判定取长边除以短边，两个方向共用这一个数。
 * 拒收时机与同 TELEGRAM_PHOTO_MAX_DIMENSION_SUM。
 */
export const TELEGRAM_PHOTO_MAX_ASPECT_RATIO: number = 20;

/** Telegram 官方 Bot API 其它文件上传的字节上限（50 MB）；cron 本地文件按它判超限。 */
export const TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES: number = 50 * 1024 * 1024;

/**
 * `deleteMessages` 单次能带的消息 id 数上限，Bot API 本身的硬上限。
 * 超出整批被拒（该接口只有整体成败），因此由调用方按这个数分片。
 */
export const TELEGRAM_DELETE_MESSAGES_BATCH_MAX: number = 100;

/** grammY 全局发送桶允许等待的消息上限；与 TELEGRAM_429_RETRY_QUEUE_MAX 分开计数。 */
export const TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX: number = 8_192;
/**
 * 全部 Telegram 429 退避域合计允许保留的任务数，正常在途请求不计入。
 *
 * 取 TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX 的 10 倍：message 类进入 429 队列之前已被
 * grammY 全局桶限在其以内，其余 13 个类别不经过任何发送桶。本值只是内存硬顶，
 * 超出即拒绝并交还领域 owner，不承担持久化。所属模块：infra/telegram/outboundQueue.ts。
 */
export const TELEGRAM_429_RETRY_QUEUE_MAX: number = 10 * TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX;
/** grammY 全局发送桶每个刷新周期放行的发送请求数（插件默认的每秒 30 次）；所属模块：infra/telegram/messageThrottler.ts。 */
export const TELEGRAM_MESSAGE_GLOBAL_RESERVOIR: number = 30;
/** grammY 全局发送桶的刷新周期；所属模块：infra/telegram/messageThrottler.ts。 */
export const TELEGRAM_MESSAGE_GLOBAL_REFRESH_INTERVAL_MS: number = 1_000;
/**
 * grammY 单群发送桶允许等待的消息上限；超出即拒绝新消息。单群只串行保序、不设
 * 独立速率，积压的排空时长取决于全局桶、请求往返与 429 退避。
 */
export const TELEGRAM_MESSAGE_GROUP_PENDING_MAX: number = 128;
/** grammY 单私聊发送桶允许等待的消息上限；防止单一目标无限占用内存。 */
export const TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX: number = 256;
/** 429 缺失合法 retry_after 时采用的保守短退避；后续响应仍以服务端值为准。 */
export const TELEGRAM_429_FALLBACK_RETRY_MS: number = 1_000;
/** 429 冷却后的单类别恢复并发上限；窗口从 1 起，仅在真实成功后逐步增长。 */
export const TELEGRAM_429_RECOVERY_MAX_CONCURRENT: number = 32;
/** 单个 JavaScript timer 可安全表达的最大毫秒延迟，超长 retry_after 分段等待。 */
export const TELEGRAM_TIMER_MAX_DELAY_MS: number = 2_147_483_647;

/** 标题回填的最大并发 getChat 数，限制低优先级维护占用 Telegram 总闸。 */
export const CHAT_TITLE_REFRESH_CONCURRENCY: number = 25;

/**
 * 自发消息登记表（见 infra/selfSentTracker.ts）的存活时长：只需覆盖「发送 →
 * 更新原样弹回」的往返时间（频道帖自回环、转发进关联讨论组的副本），
 * 未被命中的登记项到期自动清理，不值得长期占内存。
 */
export const SELF_SENT_MESSAGE_TTL_MS: number = 15_000;

/**
 * Worker 发信回执与频道 update 反向到达时，主线程等待自发标记的最长时间。
 * 只作用于频道帖子和关联讨论组自动转发，不进入普通群消息热路径。
 */
export const SELF_SENT_RENDEZVOUS_TIMEOUT_MS: number = 1_000;

/**
 * inline 源文本登记表（见 infra/inlineResultSources.ts）同时保留多少个**发言身份**
 * （结果落群后的发送者：gag 会话目标或运势查询者）。
 *
 * 每个发言身份只占一条：新一次 inline 应答整体覆盖它上一次的登记，不留历史——
 * 只有最后一次应答里的结果才可能被发出去。上限管的是「同时有多少个身份正在被
 * 输入 inline 查询」，inline 模式对任何人开放，因此必须有硬顶；撑满时按最久未
 * 登记的发言身份淘汰，被淘汰只意味着它那条 inline 结果拿不到源文本、退回不判定。
 * 单条登记的正文上界为一次应答的全部结果内容（运势回执或至多 GAG_SESSION_MAX
 * 条、each 受 TELEGRAM_MESSAGE_MAX_CHARS 约束的 gag 文本），因此整表占用有界。
 */
export const INLINE_RESULT_SOURCE_MAX_AUTHORS: number = 1_024;

/**
 * Markdown 代码块的围栏字面量；开栏（```<语言>）与闭栏（```）共用同一串。
 *
 * Telegram 客户端在发送前就把围栏折成 `pre` 实体，因此这串只出现在两处：把
 * 实体还原成可落盘文本时补写，以及把落盘文本拆回实体时识别（见
 * libs/codeFence.ts）。所属模块：packages/libs/codeFence.ts。
 */
export const CODE_FENCE: string = "```";

/**
 * 无富文本实体时共用的空实体表。
 *
 * 存在的意义是让「这条消息没有实体」这条常态不必每次都分配一个新数组——
 * 问答直答对每条命中的答案都要走一次渲染，而绝大多数答案里没有代码块。
 * 所属模块：packages/libs/codeFence.ts。
 */
export const EMPTY_MESSAGE_ENTITIES: readonly MessageEntity[] = [];

/** Telegram 发送边界关闭链接预览的共享只读载荷。 */
export const DISABLED_LINK_PREVIEW: Readonly<{ is_disabled: true }> = { is_disabled: true };

/** Telegram 编辑边界识别目标内容已经相同的拒绝语。 */
export const MESSAGE_NOT_MODIFIED: string = "message is not modified";

/** Telegram 信号适配边界在无信号时共享的只读空元组。 */
export const NO_SIGNAL_ARGS: readonly [] = [];
