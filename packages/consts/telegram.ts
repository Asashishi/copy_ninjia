import type { ChatPermissions } from "@grammyjs/types";

/** Telegram API 封装（packages/infra/telegram/）的调参常量。 */

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
 * MUTED_CHAT_PERMISSIONS 收走的那层个人限制整个摘掉。逐项显式写出的理由同
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

/**
 * `deleteMessages` 单次能带的消息 id 数上限，Bot API 本身的硬上限。
 * 超出整批被拒（该接口只有整体成败），因此由调用方按这个数分片。
 */
export const TELEGRAM_DELETE_MESSAGES_BATCH_MAX: number = 100;

/** 全部 Telegram 429 退避域合计允许保留的任务数，正常在途请求不计入。 */
export const TELEGRAM_429_RETRY_QUEUE_MAX: number = 81_920;
/** grammY 全局发送桶允许等待的消息上限；与 429 的 81,920 总容量分开计数。 */
export const TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX: number = 8_192;
/** grammY 单群发送桶允许等待的消息上限；超过约 2 分钟积压后拒绝新消息。 */
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
export const CHAT_TITLE_REFRESH_CONCURRENCY: number = 15;

/**
 * 启动期标题回填累计改动多少个群才落一次盘。逐个群落盘会把启动期变成
 * O(群数²) 的主线程 CPU——StateStore.save 每次都要对**全部**群做一遍
 * 序列化 + 解析 + 深校验，而 LatestValueRunner 只合并磁盘写、不合并这段工作。
 * 群名称不参与任何业务判断（见 infra/chatTitle.ts），中途崩溃丢掉几个标题
 * 没有副作用，因此可以放心攒批。
 */
export const CHAT_TITLE_REFRESH_SAVE_BATCH_SIZE: number = 50;

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
