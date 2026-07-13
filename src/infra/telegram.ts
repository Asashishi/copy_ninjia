import { logger } from "./logger";
import { Api, Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { autoRetry } from "@grammyjs/auto-retry";
import { BOT_TOKEN } from "./config";
import { AVATAR_FETCH_MAX_ATTEMPTS, AVATAR_FETCH_TIMEOUT_MS } from "../consts/telegram";

export const bot: Bot = new Bot(BOT_TOKEN);

/**
 * 专供入群守卫流程（workers/antiRaidWorker.ts，主线程侧代理为 antiRaid.ts）
 * 使用的独立 API 客户端。该流程可能在
 * 几秒内向同一个群突发大量 send/delete/kick 调用——比如一波人同时入群，或者
 * 踢人时要把某个刷屏者的所有消息全部删掉。这里做了限流以符合 Telegram 的
 * 单聊天/全局限制，并在遇到 429 时自动重试，让这些突发请求排队等待而不是
 * 静默失败。与共享的 `bot.api` 客户端分开，避免给其他地方的普通指令回复
 * 增加延迟或排队。
 */
export const joinVerificationApi: Api = new Api(BOT_TOKEN);
joinVerificationApi.config.use(apiThrottler());
joinVerificationApi.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 5 }));

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
    const success: boolean = await attemptCopyUserProfilePhoto(targetId, isChannel);
    if (success) return true;
    logger.error(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
  }

  if (username) {
    logger.error(`Falling back to t.me web profile scrape for @${username}`);
    const imgBuffer: Uint8Array | null = await fetchAvatarFromWebProfile(username);
    if (imgBuffer) {
      try {
        await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(imgBuffer, "avatar.jpg") });
        return true;
      } catch (error: unknown) {
        logger.error("Error setting profile photo from web fallback:", error);
      }
    }
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
    const pageRes: Response = await fetch(`https://t.me/${encodeURIComponent(username)}`, {
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!pageRes.ok) {
      logger.error(`Failed to fetch t.me profile page for @${username}: ${pageRes.status}`);
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

async function attemptCopyUserProfilePhoto(targetId: number, isChannel: boolean): Promise<boolean> {
  try {
    let fileId: string;

    if (isChannel) {
      // 频道没有 getUserProfilePhotos，只能通过 getChat 的 photo 字段拿头像（只有大小两档，无需再挑最大尺寸）
      const chat = await bot.api.getChat(targetId);
      if (!chat.photo) {
        return false;
      }
      fileId = chat.photo.big_file_id;
    } else {
      // 获取用户当前选中的头像（offset=0 即为用户当前正在使用的那张头像）
      const photos = await bot.api.getUserProfilePhotos(targetId, { offset: 0, limit: 1 });
      if (photos.total_count === 0) {
        return false;
      }

      const photoSizes = photos.photos[0];
      if (!photoSizes || photoSizes.length === 0) {
        return false;
      }

      // 按照 Telegram API 约定，同一张头像的多个尺寸按分辨率从小到大排列，
      // 因此数组最后一个元素即为分辨率最高（原图）的版本；不要用 file_size 比较，
      // 因为 file_size 是可选字段，缺失时会导致误选到缩略图。
      const largestPhoto = photoSizes[photoSizes.length - 1]!;
      fileId = largestPhoto.file_id;
    }

    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      return false;
    }

    // 下载文件内容（grammY 没有内置下载封装，仍需自己 fetch 原始字节）
    const downloadUrl: string = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const imgRes: Response = await fetch(downloadUrl, { signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
    if (!imgRes.ok) {
      // 只记录 file_path，绝不能把完整 downloadUrl 打进日志——URL 里嵌着 bot token。
      logger.error(`Failed to download avatar file (${imgRes.status}): ${file.file_path}`);
      return false;
    }
    const imgBuffer: Uint8Array = new Uint8Array(await imgRes.arrayBuffer());

    await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(imgBuffer, "avatar.jpg") });
    return true;
  } catch (error: unknown) {
    logger.error("Error copying user profile photo:", error);
    return false;
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
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return sent.message_id;
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      logger.error(`Failed to send message: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error sending message:", error);
    }
    return undefined;
  }
}

/**
 * 发送一次「正在输入…」聊天状态，用于在生成 AI 回复期间模拟真人打字。
 * 该状态在 Telegram 客户端约 5 秒后自动过期，也会在本聊天收到 bot 的下一条
 * 消息时自动清除——因此调用方无需显式关闭，只需在生成/发送耗时较长时
 * 周期性重发以维持显示（见 workers/aiChatWorker.ts 的 startTypingHeartbeat）。
 * @param chatId 目标聊天 ID。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 是否发送成功——调用方靠它判断要不要放弃继续重发（见
 *   startTypingHeartbeat：失败多半意味着该聊天已不可达，没必要每隔几秒
 *   重试一个大概率会持续失败的操作）。
 */
export async function sendTypingAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.sendChatAction(chatId, "typing");
    return true;
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      logger.error(`Failed to send typing action: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error sending typing action:", error);
    }
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
    if (error instanceof GrammyError) {
      logger.error(`Failed to answer callback query: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error answering callback query:", error);
    }
  }
}

/**
 * 向指定 Telegram 聊天发送一枚贴纸（按 file_id 引用，无需重新上传文件）。
 * @param chatId 目标聊天 ID。
 * @param fileId 贴纸的 file_id（来自 getStickerSet 返回的贴纸集合）。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 * @returns 发送是否成功——调用方靠它决定要不要把这枚贴纸自录进 AI 对话缓存。
 */
export async function sendSticker(chatId: number, fileId: string, api: Api = bot.api): Promise<boolean> {
  try {
    await api.sendSticker(chatId, fileId);
    return true;
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      logger.error(`Failed to send sticker: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error sending sticker:", error);
    }
    return false;
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
    if (error instanceof GrammyError) {
      logger.error(`Failed to set message reaction: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error setting message reaction:", error);
    }
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
    if (error instanceof GrammyError) {
      logger.error(`Failed to delete message: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error deleting message:", error);
    }
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
  setTimeout(() => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs);
}

/**
 * 将某成员移出聊天但不永久封禁：先封禁再立刻解封，这样 TA 之后若再次被邀请
 * 仍可自由加入。用于入群验证超时和反刷群的自动踢出——这些是自动触发的，
 * 不封禁以防误杀。需要机器人是拥有封禁权限的管理员。
 * @param chatId 要移出成员的聊天。
 * @param userId 要移除的成员。
 * @param api 用于发送的 API 客户端（默认使用共享的、不限流的 `bot.api`）。
 */
export async function kickChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<void> {
  try {
    await api.banChatMember(chatId, userId);
    await api.unbanChatMember(chatId, userId, { only_if_banned: true });
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      logger.error(`Failed to kick chat member: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error kicking chat member:", error);
    }
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
    if (error instanceof GrammyError) {
      logger.error(`Failed to ban chat member: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error banning chat member:", error);
    }
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
    if (error instanceof GrammyError) {
      logger.error(`Failed to ban sender chat: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error banning sender chat:", error);
    }
    return false;
  }
}

/**
 * 将指定消息复制（复读）到目标聊天。
 * @param chatId 目标聊天 ID。
 * @param fromChatId 源聊天 ID。
 * @param messageId 要复制的消息 ID。
 */
export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.copyMessage(chatId, fromChatId, messageId);
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      // Telegram 的错误详情（比如权限不足）都在 description 里，比只看 HTTP 状态更有用。
      logger.error(`Failed to copy message: ${error.error_code} ${error.description}`);
    } else {
      logger.error("Error copying message:", error);
    }
  }
}
