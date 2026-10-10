import type { ChatPermissions, MessageEntity } from "grammy/types";
import type { TelegramSubscribedUpdate } from "../types/telegram";
import { exhaustiveList } from "./exhaustiveList";
import { DAY_MS } from "./time";

/** Telegram API 封装（packages/infra/telegram/）的调参常量。 */

/** Telegram 部署示例中的 Bot token 占位值；生产严格解析必须拒绝。 */
export const TELEGRAM_BOT_TOKEN_PLACEHOLDER: string = "replace-with-telegram-bot-token";

/** Telegram update 里 `date` 字段（Unix 秒）换算成毫秒的倍数。 */
export const TELEGRAM_DATE_UNIT_MS: number = 1_000;

/** 长轮询订阅的完整 update 类型集合（TelegramSubscribedUpdate 的全部成员）。 */
export const TELEGRAM_ALLOWED_UPDATES: readonly TelegramSubscribedUpdate[] = exhaustiveList<TelegramSubscribedUpdate>()([
  "message",
  "channel_post",
  "message_reaction",
  "chat_member",
  "my_chat_member",
  "callback_query",
  "inline_query",
  "chosen_inline_result",
]);

/**
 * Bot API 服务端对重复 offset 的最短应答等待。
 *
 * 同一 offset 在上一次 getUpdates 开始后本值时长内再次请求、且 `timeout` 小于本值时，
 * 服务端把这次请求的 `timeout` 提到本值（telegram-bot-api
 * `Client::process_get_updates_query`），期间没有新 update 就到点返回空数组。
 * 停机时的最终 offset 确认属于这种请求，其本地截止必须大于本值
 * （见 consts/lifecycle.ts 的 FINAL_OFFSET_CONFIRM_TIMEOUT_MS）。所属模块：consts/lifecycle.ts。
 */
export const TELEGRAM_REPEATED_OFFSET_MIN_WAIT_MS: number = 3_000;

/** 抓取目标头像（Bot API / t.me 兜底）的单次请求超时。 */
export const AVATAR_FETCH_TIMEOUT_MS: number = 15_000;
/** 抓取目标头像允许的最大尝试次数。 */
export const AVATAR_FETCH_MAX_ATTEMPTS: number = 3;
/** 复制目标头像（Bot API 文件下载与 t.me 页面兜底）读入内存的最大字节数，与公开主页的上限各自独立。 */
export const AVATAR_MAX_DOWNLOAD_BYTES: number = 10 * 1024 * 1024;
/** 上传头像字节时附带的文件名（设置机器人静态头像、命令头像图与 /wed 结果图共用）。Bot API 只按字节内容
 *  判格式，这个名字仅出现在 multipart 的 filename 字段里。 */
export const BOT_PROFILE_PHOTO_FILE_NAME: string = "avatar.jpg";
/** 上传 MP4 动态头像时附带的文件名，仅出现在 multipart 的 filename 字段里。所属模块：infra/telegram/avatar/shared.ts。 */
export const BOT_PROFILE_ANIMATION_FILE_NAME: string = "avatar.mp4";
/**
 * Bot API 以 multipart 上传图片的上限（Bot API 文档 Sending Files：10 MB max size for photos），MB 按
 * Bot API 服务端的 2^20 字节计。JPEG/PNG 默认头像按此核对。所属模块：infra/telegram/avatar/photoType.ts。
 */
export const BOT_PROFILE_PHOTO_MAX_BYTES: number = 10 * 1024 * 1024;
/**
 * Bot API 以 multipart 上传其他文件的上限（Bot API 文档 Sending Files：50 MB for other files），MB 按
 * Bot API 服务端的 2^20 字节计。MP4 动态默认头像按此核对。所属模块：infra/telegram/avatar/photoType.ts。
 */
export const BOT_PROFILE_ANIMATION_MAX_BYTES: number = 50 * 1024 * 1024;
/**
 * MP4 动态头像视频轨的最大边长（像素）；视频轨须为正方形且宽高不超过此值（MTProto 文档 Animated profile
 * pictures：square MPEG4 videos up to 1080x1080）。所属模块：infra/telegram/avatar/photoType.ts。
 */
export const BOT_PROFILE_ANIMATION_MAX_SIDE: number = 1_080;
/**
 * 默认头像直链单次下载的超时，含 externalFetch 类出站闸的 429 重放等待；JPEG/PNG 与 MP4 共用。复制目标头像仍按
 * AVATAR_FETCH_TIMEOUT_MS 计时。所属模块：infra/telegram/avatar/restore.ts。
 */
export const DEFAULT_AVATAR_FETCH_TIMEOUT_MS: number = 90_000;
/**
 * 默认头像有界读取的上限，取两种上传形态上限中较大的一个；读到的字节再由 defaultAvatarPhotoType 按所属
 * 形态的上限核对。所属模块：config/assets.ts、infra/telegram/avatar/restore.ts。
 */
export const DEFAULT_AVATAR_MAX_READ_BYTES: number =
  Math.max(BOT_PROFILE_PHOTO_MAX_BYTES, BOT_PROFILE_ANIMATION_MAX_BYTES);
/**
 * 默认头像素材的期望形态（判定见 infra/telegram/avatar/photoType.ts）；启动核对的报错与复原失败日志共用。
 * 所属模块：config/assets.ts、infra/telegram/avatar/restore.ts。
 */
export const DEFAULT_AVATAR_EXPECTED_FORM: string =
  `a JPEG or PNG image of at most ${BOT_PROFILE_PHOTO_MAX_BYTES} bytes ` +
  `or an MP4 video of at most ${BOT_PROFILE_ANIMATION_MAX_BYTES} bytes whose video tracks are square ` +
  `and at most ${BOT_PROFILE_ANIMATION_MAX_SIDE}x${BOT_PROFILE_ANIMATION_MAX_SIDE}`;

/** t.me 公开主页响应允许读入内存的最大字节数。 */
export const PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES: number = 1024 * 1024;
/**
 * t.me / telegram.me 公开主页允许返回头像资源的 Telegram 自有域。后缀由
 * packages/libs/httpUrlPolicy.ts 按 DNS label 边界匹配；这里只限制轻量出站能力，
 * 不承担 DNS/IP 级 SSRF 防护。
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

/**
 * 禁言一名成员时写给 `restrictChatMember` 的权限集：全部收走。
 *
 * 除 `can_edit_tag` 外每一项都显式写为 false、不依赖缺省；`can_react_to_messages`
 * 缺省跟随 `can_send_messages`，同样显式关闭。全项为 false，无需带 `use_independent_chat_permissions`。
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
 * 成员的实际权限仍与群默认权限取交集，本集合只摘掉 MUTED_CHAT_PERMISSIONS 收走的个人限制。
 * 逐项显式写出，必须与禁言集逐项对应；全项为 true，无需带 `use_independent_chat_permissions`。
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
 * 私密模式把 `getChat().permissions` 原样读回、只改 `can_invite_users` 再写回，
 * 其中必然有为 true 的项。带上该标志后各权限项独立生效，`can_send_other_messages`
 * 与 `can_send_polls` 不连带蕴含其它发送权限，读改写保持原权限集不变。
 *
 * 所属模块：packages/infra/telegram/lockdownPermissions.ts 与
 * packages/workers/antiRaid/lockdownApi.ts。
 */
export const INDEPENDENT_CHAT_PERMISSIONS_OTHER: Readonly<{
  use_independent_chat_permissions: true;
}> = {
  use_independent_chat_permissions: true,
};

/** Telegram 文本消息的长度上限（字符），超出被 Bot API 拒绝。 */
export const TELEGRAM_MESSAGE_MAX_CHARS: number = 4096;

/**
 * 媒体消息 caption 的长度上限（字符），超出被 Bot API 拒绝而不截断。按 UTF-16 code unit 计，
 * 与 JS 的 `String.length` 同口径，调用方直接用 `.length` 判定。
 */
export const TELEGRAM_CAPTION_MAX_CHARS: number = 1024;

/** Telegram 官方 Bot API 图片上传的字节上限；随机图片与 cron 本地图片按它判超限。 */
export const TELEGRAM_PHOTO_UPLOAD_MAX_BYTES: number = 10 * 1024 * 1024;

/**
 * `sendPhoto` 对宽高之和的官方上限（width + height 不得超过它）。
 *
 * 与字节上限并列、互不蕴含；`/h_image add` 收图时经 libs/telegramImage.ts 的
 * isSendablePhotoDimensions 按它拒收（commands/hImage/add.ts）。
 */
export const TELEGRAM_PHOTO_MAX_DIMENSION_SUM: number = 10_000;

/**
 * `sendPhoto` 对长宽比的官方上限，两个方向共用；判定取长边除以短边。
 * 拒收时机同 TELEGRAM_PHOTO_MAX_DIMENSION_SUM。
 */
export const TELEGRAM_PHOTO_MAX_ASPECT_RATIO: number = 20;

/** Telegram 官方 Bot API 其它文件上传的字节上限；cron 本地文件按它判超限。 */
export const TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES: number = 50 * 1024 * 1024;

/**
 * `deleteMessages` 单次能带的消息 id 数上限，Bot API 官方上限。
 * 超出整批被拒，调用方按该数分片。
 */
export const TELEGRAM_DELETE_MESSAGES_BATCH_MAX: number = 100;

/**
 * 发送调度器全部聊天合计允许排队的发送请求数（不含各聊天在途的那一条）；超出即拒绝新请求。
 * 与 TELEGRAM_429_RETRY_QUEUE_MAX 分开计数。所属模块：infra/telegram/sendScheduler.ts。
 */
export const TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX: number = 8_192;
/**
 * 全部 Telegram 429 退避域合计允许保留的任务数，正常在途请求不计入。
 *
 * 取 TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX 的固定倍数。非发送类在 outboundQueue 的退避域里等待，
 * 入队时按本值拒绝；发送类的 429 等待放回发送调度器的聊天车道队首，不按本值拒绝（已受
 * TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX 约束），但同样计入 retryPendingCount，占用非发送类的额度。
 * 本值是内存硬顶，超出即拒绝并交还领域 owner，不承担持久化。所属模块：infra/telegram/outboundQueue.ts。
 */
export const TELEGRAM_429_RETRY_QUEUE_MAX: number = 4 * TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX;
/**
 * 单个群类聊天（负数 id 或 `@username`）允许排队的发送请求数；超出即拒绝新请求。
 * 所属模块：infra/telegram/sendScheduler.ts。
 */
export const TELEGRAM_MESSAGE_GROUP_PENDING_MAX: number = 128;
/** 单个私聊允许排队的发送请求数；超出即拒绝新请求。所属模块：infra/telegram/sendScheduler.ts。 */
export const TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX: number = 256;
/**
 * 全局滑动窗口内最多放行的发送条数，对应 Telegram FAQ 的广播频率上限；所有聊天共用。
 * 所属模块：infra/telegram/sendScheduler.ts。
 */
export const TELEGRAM_SEND_GLOBAL_LIMIT: number = 30;
/** 全局发送窗口长度。所属模块：infra/telegram/sendScheduler.ts。 */
export const TELEGRAM_SEND_GLOBAL_WINDOW_MS: number = 1_000;
/**
 * 单聊天令牌桶的正常突发容量：安静一段时间后可连发这么多条，之后按
 * TELEGRAM_SEND_CHAT_REFILL_MS 每条补一个（对应 Telegram FAQ 的单聊天频率与短突发允许）。
 * 所属模块：infra/telegram/sendScheduler.ts。
 */
export const TELEGRAM_SEND_CHAT_BURST: number = 3;
/** 单聊天令牌桶补一个令牌的间隔。所属模块：infra/telegram/sendScheduler.ts。 */
export const TELEGRAM_SEND_CHAT_REFILL_MS: number = 1_000;
/**
 * 聊天收到 429 后，冻结结束起算的保守档时长：期间突发容量降为 1，再次 429 则顺延。
 * 所属模块：infra/telegram/sendScheduler.ts。
 */
export const TELEGRAM_SEND_CHAT_CAUTIOUS_MS: number = 60_000;
/**
 * 群类聊天滑动窗口内最多发送的条数，对应 Telegram FAQ 的群内发送频率上限。
 * 所属模块：infra/telegram/sendScheduler.ts。
 */
export const TELEGRAM_SEND_GROUP_LIMIT: number = 20;
/** 群类聊天发送窗口长度，也是空闲车道的保留时长。所属模块：infra/telegram/sendScheduler.ts。 */
export const TELEGRAM_SEND_GROUP_WINDOW_MS: number = 60_000;
/** 429 缺失合法 retry_after 时采用的保守短退避；后续响应仍以服务端值为准。 */
export const TELEGRAM_429_FALLBACK_RETRY_MS: number = 1_000;
/** 429 冷却后的单类别恢复并发上限；窗口从 1 起，仅在真实成功后逐步增长。 */
export const TELEGRAM_429_RECOVERY_MAX_CONCURRENT: number = 32;
/**
 * 单个 JavaScript timer 可安全表达的最大毫秒延迟，超长 retry_after 分段等待。
 * 所属模块：infra/telegram/outboundGate.ts（按类别退避）与 infra/telegram/sendScheduler.ts（聊天车道）。
 */
export const TELEGRAM_TIMER_MAX_DELAY_MS: number = 2_147_483_647;

/**
 * 自发消息登记表（见 infra/selfSentTracker.ts）的存活时长，覆盖「发送 →
 * 更新原样弹回」的往返（频道帖自回环、转发进关联讨论组的副本）；
 * 未被命中的登记项到期清理。
 */
export const SELF_SENT_MESSAGE_TTL_MS: number = 15_000;

/**
 * 频道 update 先于发送回执到达、且目标 chat 仍有在途自发发送时，等待自发标记的最长时间；
 * 在途发送全部结算即提前按 false 结束。只作用于频道帖子和关联讨论组自动转发，不进入
 * 普通群消息热路径。所属模块：infra/selfSentTracker.ts。
 */
export const SELF_SENT_RENDEZVOUS_TIMEOUT_MS: number = 1_000;

/**
 * inline 源文本登记表（见 infra/inlineResultSources.ts）同时保留的**发言身份**
 * （结果落群后的发送者：gag 会话目标或运势查询者）上限。
 *
 * 每个发言身份只占一条：新一次 inline 应答整体覆盖它上一次的登记。撑满时按最久未
 * 登记的发言身份淘汰，被淘汰身份的 inline 结果拿不到源文本、退回不判定。
 * 单条登记的正文以一次应答的全部结果内容为界（运势回执或至多 GAG_SESSION_MAX
 * 条、每条受 TELEGRAM_MESSAGE_MAX_CHARS 约束的 gag 文本），整表占用有界。
 */
export const INLINE_RESULT_SOURCE_MAX_AUTHORS: number = 1_024;

/**
 * Markdown 代码块的围栏字面量；开栏（```<语言>）与闭栏（```）共用同一串。
 *
 * Telegram 客户端发送前把围栏折成 `pre` 实体；这串只用于两处：把实体还原成
 * 可落盘文本时补写，以及把落盘文本拆回实体时识别（见 libs/codeFence.ts）。
 * 所属模块：packages/libs/codeFence.ts。
 */
export const CODE_FENCE: string = "```";

/**
 * 无富文本实体时共用的空实体表，调用方不分配新数组。
 * 所属模块：packages/libs/codeFence.ts。
 */
export const EMPTY_MESSAGE_ENTITIES: readonly MessageEntity[] = [];

/** Telegram 发送边界关闭链接预览的共享只读载荷。 */
export const DISABLED_LINK_PREVIEW: Readonly<{ is_disabled: true }> = { is_disabled: true };

/** Telegram 编辑边界识别目标内容已经相同的拒绝语。 */
export const MESSAGE_NOT_MODIFIED: string = "message is not modified";

/**
 * Bot API 限制成员时的永久分界：`until_date` 距当前超过 366 天按永久限制处理。`/mute` 的上限
 * consts/commands.ts 的 MUTE_MAX_DURATION_MS 须留在它之下，由 test/commands/mute.test.ts 核对。
 */
export const TELEGRAM_RESTRICTION_FOREVER_AFTER_MS: number = 366 * DAY_MS;
