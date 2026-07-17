import { logger } from "./logger";
import { Api, Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { autoRetry } from "@grammyjs/auto-retry";
import { BOT_TOKEN } from "./config";
import {
  API_RETRY_MAX_ATTEMPTS,
  API_RETRY_MAX_DELAY_SECONDS,
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_FETCH_TIMEOUT_MS,
  USER_PROFILE_PHOTOS_LIMIT,
} from "../consts/telegram";
import { markSelfSent } from "./selfSentTracker";

export const bot: Bot = new Bot(BOT_TOKEN);
// 全仓共享的默认客户端也要限流+自动重试：AI 闲聊回复（触发频率最高、最
// 具突发性的发送路径，多个群同时命中随机回复/概率评价时可能在同一秒扎堆
// 发起请求）、复读、/luck_challenge 等都经它发送，此前只有下面的
// joinVerificationApi（入群验证专用）有这层保护，稳态高并发下这条默认路径
// 撞上 429 只会静默丢消息（见 sendMessage 等封装的 catch 分支）。
bot.api.config.use(apiThrottler());
bot.api.config.use(autoRetry({ maxRetryAttempts: API_RETRY_MAX_ATTEMPTS, maxDelaySeconds: API_RETRY_MAX_DELAY_SECONDS }));

/**
 * 统一记录一次 Telegram API 调用失败。GrammyError 的错误详情（比如权限
 * 不足）都在 description 里，比只看 HTTP 状态更有用，展开记录；其余异常
 * 原样记录。本文件的各封装共用，也供绕过封装直接调 bot.api 的地方
 * （如 reactionQueue）使用。
 * @param action 失败的动作，用于日志文案（如 "send message"）。
 */
export function logApiError(action: string, error: unknown): void {
  if (error instanceof GrammyError) {
    logger.error(`Failed to ${action}: ${error.error_code} ${error.description}`);
  } else {
    logger.error(`Error trying to ${action}:`, error);
  }
}

/**
 * 专供入群守卫流程（workers/antiRaidWorker.ts，主线程侧代理为 antiRaid.ts）
 * 使用的独立 API 客户端。该流程可能在几秒内向同一个群突发大量
 * send/delete/kick 调用——比如一波人同时入群，或者踢人时要把某个刷屏者的
 * 所有消息全部删掉，比默认的 `bot.api` 更容易短时间内扎堆。限流/重试参数
 * 与上面的 `bot.api` 相同，只是各自独立排队——分开成两个客户端实例，避免
 * 入群验证的突发流量与其他地方的普通指令回复互相抢占排队名额、增加延迟。
 */
export const joinVerificationApi: Api = new Api(BOT_TOKEN);
joinVerificationApi.config.use(apiThrottler());
joinVerificationApi.config.use(autoRetry({ maxRetryAttempts: API_RETRY_MAX_ATTEMPTS, maxDelaySeconds: API_RETRY_MAX_DELAY_SECONDS }));

/**
 * 拼出某个 file_path 对应的 Bot API 文件下载直链。这条 URL 本身嵌着
 * BOT_TOKEN——调用方绝不能把完整返回值打进日志（只记录 filePath 是安全的），
 * 也要留意任何把它原样传给 Telegram 的地方（比如内联查询结果的
 * thumbnail_url）：一旦对应的 API 调用出错，错误对象上可能会带着这个 URL，
 * 经过日志的 Error 序列化就可能把 token 写进日志文件。
 * @param filePath getFile 返回的 file_path。
 */
export function buildFileDownloadUrl(filePath: string): string {
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
}

/**
 * 下载某用户（或频道）的头像，并上传设置为本机器人的头像。
 * 优先走 Bot API；若多次尝试都失败且目标有公开 username，则退而爬取
 * t.me/<username> 公开主页上展示的头像作为兜底（见 fetchAvatarFromWebProfile）。
 * @param targetId 目标用户或频道 ID。
 * @param isChannel 目标是否为频道（频道要通过 getChat 而非 getUserProfilePhotos 获取头像）。
 * @param username 目标的公开 username（不带 @），用于 t.me 主页爬取兜底；没有则跳过兜底。
 * @returns 成功时 resolve 为 true，否则为 false。
 */
export async function copyUserProfilePhoto(targetId: number, isChannel: boolean = false, username?: string): Promise<boolean> {
  for (let attempt: number = 1; attempt <= AVATAR_FETCH_MAX_ATTEMPTS; attempt++) {
    const result: AvatarCopyAttemptResult = await attemptCopyUserProfilePhoto(targetId, isChannel);
    if (result === "ok") return true;
    logger.error(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
    // 确定性失败（对方没有可见头像之类）重试也不会有不同结果：白白多打
    // 两轮 API、把同一条错误日志刷三遍，直接跳去网页爬取兜底。
    if (result === "permanent-failure") break;
  }

  if (username) {
    logger.error(`Falling back to t.me web profile scrape for @${username}`);
    const imgBuffer: Uint8Array | null = await fetchAvatarFromWebProfile(username);
    if (imgBuffer) {
      try {
        await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(imgBuffer, "avatar.jpg") });
        return true;
      } catch (error: unknown) {
        // 同 copyUserProfilePhoto 的 catch：payload 带着图片字节，不能原样落盘。
        logApiError("set profile photo from web fallback", error);
      }
    }
  } else {
    // 没有公开 username 就没有 t.me/<username> 主页可爬，兜底本来就不可能，
    // 但必须留下这行日志——否则从日志上看只有几次失败的尝试，完全看不出
    // 兜底为什么没触发。
    logger.error(`Skipping t.me web profile scrape fallback: ${isChannel ? "channel" : "user"} ${targetId} has no public username`);
  }
  return false;
}

/**
 * 兜底机制：从 t.me/<username> 公开主页爬取头像图片。
 * 有公开 username 的用户/频道，其 t.me 主页会以
 * `<img class="tgme_page_photo_image" src="https://cdn….telesco.pe/file/….jpg">`
 * 的形式直接暴露头像 CDN 链接，无需鉴权即可抓取——即使 Bot API 因隐私设置等
 * 原因拿不到头像，这里往往仍能拿到。
 * @param username 目标的公开 username（不带 @）。
 * @returns 头像图片字节，页面无头像或抓取失败时返回 null。
 */
export async function fetchAvatarFromWebProfile(username: string): Promise<Uint8Array | null> {
  try {
    const pageRes: Response = await fetch(`https://telegram.me/${encodeURIComponent(username)}`, {
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!pageRes.ok) {
      logger.error(`Failed to fetch telegram.me profile page for @${username}: ${pageRes.status}`);
      return null;
    }
    const html: string = await pageRes.text();

    // 先定位头像的 <img> 标签再取 src，兼容属性顺序变化；没设公开头像的
    // 主页根本没有这个标签，此时直接放弃兜底。
    const imgTagMatch = html.match(/<img[^>]*class="[^"]*tgme_page_photo_image[^"]*"[^>]*>/);
    const srcMatch = imgTagMatch?.[0].match(/src="([^"]+)"/);
    const photoUrl: string | undefined = srcMatch?.[1];
    if (!photoUrl || !photoUrl.startsWith("https://")) {
      logger.error(`No profile photo found on t.me page for @${username}`);
      return null;
    }

    const imgRes: Response = await fetch(photoUrl, { signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
    if (!imgRes.ok) {
      logger.error(`Failed to download avatar from ${photoUrl}: ${imgRes.status}`);
      return null;
    }
    return new Uint8Array(await imgRes.arrayBuffer());
  } catch (error: unknown) {
    logger.error(`Error scraping t.me profile photo for @${username}:`, error);
    return null;
  }
}

/** 单次头像复制尝试的结果：区分「重试可能成功」和「重试注定同样失败」。 */
type AvatarCopyAttemptResult = "ok" | "transient-failure" | "permanent-failure";

async function attemptCopyUserProfilePhoto(targetId: number, isChannel: boolean): Promise<AvatarCopyAttemptResult> {
  try {
    let fileId: string;

    if (isChannel) {
      // 频道没有 getUserProfilePhotos，只能通过 getChat 的 photo 字段拿头像（只有大小两档，无需再挑最大尺寸）
      const chat = await bot.api.getChat(targetId);
      if (!chat.photo) {
        logger.error(`Channel ${targetId} has no chat photo visible to the bot`);
        return "permanent-failure";
      }
      fileId = chat.photo.big_file_id;
    } else {
      // 注意：getUserProfilePhotos 的 offset=0 并不一定是用户当前正在使用的头像——
      // 用户可能切换回了历史头像中的某一张，此时它在 photos 数组里的位置会靠后。
      // 真正代表“当前使用中”的头像，是 getChat 返回的 chat.photo.big_file_unique_id，
      // 所以要用它去匹配 getUserProfilePhotos 历史记录里对应的那一组尺寸，
      // 才能拿到可下载的 file_id（big_file_unique_id 本身不能直接用于下载）。
      const chat = await bot.api.getChat(targetId);
      const activeUniqueId: string | undefined = chat.photo?.big_file_unique_id;

      const photos = await bot.api.getUserProfilePhotos(targetId, { offset: 0, limit: USER_PROFILE_PHOTOS_LIMIT });
      if (photos.total_count === 0) {
        // 拿不到任何头像：可能确实没设头像，也可能是隐私设置对非联系人隐藏
        // 了头像——两种情况 Bot API 无从区分。
        logger.error(`User ${targetId} has no profile photos visible to the bot (privacy settings or no avatar)`);
        return "permanent-failure";
      }

      // 按照 Telegram API 约定，同一张头像的多个尺寸按分辨率从小到大排列，
      // 因此数组最后一个元素即为分辨率最高（原图）的版本；不要用 file_size 比较，
      // 因为 file_size 是可选字段，缺失时会导致误选到缩略图。
      // big_file_unique_id 对应的正是最大尺寸版本，所以要拿每组最后一个元素的
      // file_unique_id 去和它比较。
      const matchedPhoto = activeUniqueId
        ? photos.photos.find((sizes) => sizes.length > 0 && sizes[sizes.length - 1]!.file_unique_id === activeUniqueId)?.at(-1)
        : undefined;

      // 没匹配到（用户没有 chat.photo，或历史超过 limit=100 翻页没覆盖到）就直接
      // 判失败，绝不能偷偷用最新一组顶替——那样会把错的头像悄悄冒充成功。这里老实
      // 返回 false，让外层 copyUserProfilePhoto 的重试循环用尽后，正常触发
      // 更靠谱的 t.me 网页爬虫兜底（见 fetchAvatarFromWebProfile，它直接读页面上
      // 展示的当前头像，天然准确）。
      if (!matchedPhoto) {
        logger.error(`Active avatar of user ${targetId} not found among their visible profile photos (no chat.photo, or history beyond first 100)`);
        return "permanent-failure";
      }

      fileId = matchedPhoto.file_id;
    }

    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.error(`getFile for target ${targetId}'s avatar returned no file_path`);
      return "permanent-failure";
    }

    // 下载文件内容（grammY 没有内置下载封装，仍需自己 fetch 原始字节）
    const downloadUrl: string = buildFileDownloadUrl(file.file_path);
    const imgRes: Response = await fetch(downloadUrl, { signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
    if (!imgRes.ok) {
      // 只记录 file_path，绝不能把完整 downloadUrl 打进日志——URL 里嵌着 bot token。
      logger.error(`Failed to download avatar file (${imgRes.status}): ${file.file_path}`);
      return "transient-failure";
    }
    const imgBuffer: Uint8Array = new Uint8Array(await imgRes.arrayBuffer());

    await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(imgBuffer, "avatar.jpg") });
    return "ok";
  } catch (error: unknown) {
    // 网络抖动、限流（429）等异常路径都值得重试。必须走 logApiError 而不能把
    // 原始错误直接落盘：GrammyError 的 payload 里挂着整张头像的原始字节，
    // logger 展开可枚举属性时会把它序列化成数 MB 的数字键对象刷爆日志。
    logApiError("copy user profile photo", error);
    return "transient-failure";
  }
}

/**
 * 向指定 Telegram 聊天发送文本消息。
 * 重要：这里绝不能传 parse_mode。文本内容可能来自不受信任的用户（原样或反转后被
 * 复读回去），不设置 parse_mode 会让 Telegram 把它当作纯文本处理——不解析任何
 * HTML/MarkdownV2 实体，从而杜绝了格式/链接注入的可能。
 * @param chatId 目标聊天 ID。
 * @param text 消息文本。
 * @param replyToMessageId 可选，要回复的消息 ID。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @param keyboard 可选，附带的内联键盘（如入群验证按钮）。
 * @returns 发送成功时返回该消息的 ID，失败则返回 undefined。
 */
export async function sendMessage(chatId: number, text: string, replyToMessageId?: number, api: Api = bot.api, keyboard?: InlineKeyboard): Promise<number | undefined> {
  try {
    const sent = await api.sendMessage(chatId, text, {
      // allow_sending_without_reply：被引用的消息可能已被删除（尤其 AI 回复
      // 排队补跑时，触发消息在等待期间被撤回/清理），此时宁可不挂引用也要
      // 把话发出去，不能整条静默失踪。
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    markSelfSent(chatId, sent.message_id);
    return sent.message_id;
  } catch (error: unknown) {
    logApiError("send message", error);
    return undefined;
  }
}

/**
 * 发送一次「正在输入…」聊天状态，用于在生成 AI 回复期间模拟真人打字。
 * 该状态在 Telegram 客户端约 5 秒后自动过期，也会在本聊天收到 bot 的下一条
 * 消息时自动清除——因此调用方无需显式关闭，只需在生成/发送耗时较长时
 * 周期性重发以维持显示（见 ai/chatActionHeartbeat.ts）。
 * @param chatId 目标聊天 ID。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 是否发送成功——聊天状态心跳据此累计连续失败次数；单次失败继续
 *   尝试，达到阈值才对大概率不可达的聊天止损。
 */
export async function sendTypingAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.sendChatAction(chatId, "typing");
    return true;
  } catch (error: unknown) {
    logApiError("send typing action", error);
    return false;
  }
}

/**
 * 发送一次「正在选择贴纸…」聊天状态（choose_sticker），机制与
 * sendTypingAction 完全相同（约 5 秒自动过期、bot 下一条消息发出时清除），
 * 用于 AI 挑贴纸期间模拟真人翻贴纸面板的状态——聊天状态心跳切到
 * choose_sticker 挡时由它维持显示（见 ai/chatActionHeartbeat.ts 与
 * ai/tools/stickers.ts 的 viewStickerPackTool）。
 * @returns 是否发送成功，供聊天状态心跳累计连续失败次数并决定是否止损。
 */
export async function sendChooseStickerAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.sendChatAction(chatId, "choose_sticker");
    return true;
  } catch (error: unknown) {
    logApiError("send choose sticker action", error);
    return false;
  }
}

/**
 * 应答一次 callback_query（内联按钮点击），消除客户端按钮上的加载态，
 * 可选地弹出一个提示气泡/弹窗。
 * @param callbackQueryId 要应答的 callback_query ID。
 * @param text 可选，提示文本。
 * @param showAlert 是否以弹窗（而非一闪而过的 toast）形式展示提示文本。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert: boolean = false, api: Api = bot.api): Promise<void> {
  try {
    await api.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert });
  } catch (error: unknown) {
    logApiError("answer callback query", error);
  }
}

/**
 * 向指定 Telegram 聊天发送一枚贴纸（按 file_id 引用，无需重新上传文件）。
 * @param chatId 目标聊天 ID。
 * @param fileId 贴纸的 file_id（来自 getStickerSet 返回的贴纸集合）。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 发送成功时返回该消息的 ID（调用方可用它判断要不要把这枚贴纸自录
 *   进 AI 对话缓存、报回主线程登记自发消息），失败则返回 undefined。
 */
export async function sendSticker(chatId: number, fileId: string, api: Api = bot.api): Promise<number | undefined> {
  try {
    const sent = await api.sendSticker(chatId, fileId);
    markSelfSent(chatId, sent.message_id);
    return sent.message_id;
  } catch (error: unknown) {
    logApiError("send sticker", error);
    return undefined;
  }
}

/**
 * 给指定消息设置一个标准 emoji 反应（会覆盖机器人在该消息上原有的反应）。
 * 注意：emoji 只能是 Telegram 文档里列出的固定反应表情集合之一——bot 不能
 * 给消息设置任意 emoji，也不能设置消息上原本不存在的自定义表情反应
 * （两者都会被 Bot API 拒绝，报 REACTION_INVALID）。
 * @param chatId 消息所在的聊天。
 * @param messageId 要设置反应的消息。
 * @param emoji 标准反应 emoji（须在 Telegram 允许的反应表情集合内——调用方
 *   自行保证，这里只做类型断言，不做运行时校验）。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export async function setMessageReaction(chatId: number, messageId: number, emoji: string, api: Api = bot.api): Promise<void> {
  try {
    await api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }]);
  } catch (error: unknown) {
    logApiError("set message reaction", error);
  }
}

/**
 * 删除一条消息。用于在用户未能及时通过入群验证时，清理相关痕迹
 * （提醒消息 + TA 期间发送的内容）。
 * @param chatId 消息所在的聊天。
 * @param messageId 要删除的消息。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export async function deleteMessage(chatId: number, messageId: number, api: Api = bot.api): Promise<void> {
  try {
    await api.deleteMessage(chatId, messageId);
  } catch (error: unknown) {
    logApiError("delete message", error);
  }
}

/**
 * 安排一条消息在延迟后被删除。触发即忘（fire-and-forget）——用于踢人公告，
 * 这类消息应当自行清理而不是一直留在聊天里。
 * @param chatId 消息所在的聊天。
 * @param messageId 要删除的消息。
 * @param delayMs 删除前等待的毫秒数。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export function deleteMessageAfter(chatId: number, messageId: number, delayMs: number, api: Api = bot.api): void {
  // unref：这只是清理美化，不值得为它拖住进程停机（停机后消息留着就留着）。
  setTimeout(() => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs).unref();
}

/**
 * 将某成员移出聊天但不永久封禁：单次 unbanChatMember 完成。Bot API 保证
 * 这个调用（不带 only_if_banned）之后「该用户不是聊天成员、且可以自由再
 * 加入」——对在群成员的效果就是踢出且不进封禁名单；带上 only_if_banned
 * 反而会退化成「仅对已封禁者生效」的纯解封，踢不动在群成员。之前的实现
 * 是先 banChatMember 再 unbanChatMember 两次请求，存在「封禁成功、解封
 * 失败，人被卡在封禁名单里」的中间态；单请求天然原子，没有这个失败窗口。
 * 用于入群验证超时和反刷群的自动踢出——这些是自动触发的，不封禁以防误杀。
 * 需要机器人是拥有封禁权限的管理员。
 * @param chatId 要移出成员的聊天。
 * @param userId 要移除的成员。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 踢出是否成功——超时踢人的战报要靠它区分真踢出和没踢动（缺权限时
 *          不能对着还在群里的人宣布"已踢出"）。
 */
export async function kickChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.unbanChatMember(chatId, userId);
    return true;
  } catch (error: unknown) {
    // 带上群/用户 id：踢人失败多半是机器人在该群缺封禁权限，不点名群号的话
    // 没法知道该去哪个群补权限。
    logApiError(`kick chat member (chat ${chatId}, user ${userId})`, error);
    return false;
  }
}

/**
 * 将某成员移出聊天并永久封禁（不解封，TA 无法再自行加入或被普通成员邀请回来）。
 * 用于 /kick 命令——那是管理员的手动判断，与自动踢出不同，要的就是封死。
 * 需要机器人是拥有封禁权限的管理员。
 * @param chatId 要封禁成员的聊天。
 * @param userId 要封禁的成员。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 封禁是否成功——/kick 的战报要靠它区分真踢出和假成功。
 */
export async function banChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.banChatMember(chatId, userId);
    return true;
  } catch (error: unknown) {
    logApiError(`ban chat member (chat ${chatId}, user ${userId})`, error);
    return false;
  }
}

/**
 * 查询某用户此刻是否为指定聊天的当前成员（含被限制发言的成员，不含已离开
 * /已被踢的历史成员）。用于 /kick 在真正封禁前区分「TA 现在就在这个群，这
 * 是把 TA 踢出去」和「TA 根本没加入过/已经不在了，这只是提前拉黑」——两者
 * 战报文案不同，不能笼统都说成"踢出去"。
 * 查询失败（网络错误、机器人权限不足等）一律按「不是成员」处理（fail
 * closed）：宁可战报文案偏保守地说成"提前拉黑"，也不要在没查清楚的情况下
 * 声称把人从 TA 可能根本不在的群里踢了出去。
 * @param chatId 要查询的聊天。
 * @param userId 要查询的用户。
 * @param api 用于查询的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export async function isChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    // restricted 状态会在人离开后仍保留到限制到期，是否在群要看 is_member。
    if (member.status === "restricted") return member.is_member;
    return member.status === "creator" || member.status === "administrator" || member.status === "member";
  } catch (error: unknown) {
    logApiError(`check chat membership (chat ${chatId}, user ${userId})`, error);
    return false;
  }
}

/**
 * 封禁一个以频道身份（sender_chat）在本聊天发言的频道马甲，使其无法再发消息。
 * banChatMember 只接受用户 id，对频道马甲必须走这个接口；Telegram 不向 bot
 * 暴露马甲背后的真人，所以这已经是能做到的最彻底的"踢频道"。
 * 需要机器人是拥有封禁权限的管理员。
 * @param chatId 要封禁频道马甲的聊天。
 * @param senderChatId 要封禁的频道 id（`-100…` 形式）。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 封禁是否成功——/kick 的战报要靠它区分真踢出和假成功。
 */
export async function banChatSenderChat(chatId: number, senderChatId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.banChatSenderChat(chatId, senderChatId);
    return true;
  } catch (error: unknown) {
    logApiError(`ban sender chat (chat ${chatId}, sender chat ${senderChatId})`, error);
    return false;
  }
}

/**
 * 将指定消息复制（复读）到目标聊天。
 * @param chatId 目标聊天 ID。
 * @param fromChatId 源聊天 ID。
 * @param messageId 要复制的消息 ID。
 * @returns 发送成功时返回复制出来那条新消息的 ID，失败则返回 undefined。
 */
export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<number | undefined> {
  try {
    const copied = await bot.api.copyMessage(chatId, fromChatId, messageId);
    markSelfSent(chatId, copied.message_id);
    return copied.message_id;
  } catch (error: unknown) {
    logApiError("copy message", error);
    return undefined;
  }
}
