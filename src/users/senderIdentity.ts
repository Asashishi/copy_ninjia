import type { CachedUser } from "../types";
import { userCache } from "../cache/senderIdentity";
import { USER_CACHE_MAX } from "../consts/senderIdentity";

/**
 * 消息发送者的身份解析与缓存。自动流程（src/auto/message.ts 靠 cacheSender
 * 刷新 username 缓存）和命令处理（src/commands 下的 /copy、/kick 靠
 * resolveReplyTarget 从被回复的消息定位目标，靠 resolveUsernameTarget 按
 * @username 定位目标）共用这一份逻辑。缓存状态见 cache/senderIdentity.ts。
 */

/**
 * 解析出一条消息发送者的 CachedUser 形态身份：可能是真实 Telegram 用户
 * （`from`），也可能是通过 `sender_chat` 或纯粹的 `channel_post`（这种情况下
 * 没有 `sender_chat`，帖子自身的 `chat` 就是该频道）体现的频道身份。既用于
 * 填充 username 缓存，也用于直接从被回复的消息中解析出 /copy 目标。
 */
function resolveSenderIdentity(message: any): CachedUser | undefined {
  const fromUser: any = message.from;
  const senderChat: any = message.sender_chat || (message.chat.type === "channel" ? message.chat : undefined);

  if (senderChat) {
    return {
      id: senderChat.id,
      username: senderChat.username,
      title: senderChat.title,
      isChannel: true,
    };
  } else if (fromUser) {
    return {
      id: fromUser.id,
      username: fromUser.username,
      first_name: fromUser.first_name,
      last_name: fromUser.last_name,
    };
  }

  return undefined;
}

/**
 * 记录/刷新某个发送者的缓存条目（两类身份见上方 resolveSenderIdentity），
 * 以便之后 /copy @username 能找到 TA。没有公开 username 的发送者不入缓存
 * （见 CachedUser 注释），但仍可经 resolveReplyTarget 定位。
 * @returns 解析出的发送者 id（若以频道身份发送则为频道 id，否则为用户 id）。
 */
export function cacheSender(message: any): number | undefined {
  const identity = resolveSenderIdentity(message);
  if (!identity) return undefined;

  if (identity.username) {
    const lowerUsername: string = identity.username.toLowerCase();
    const cached = userCache.get(lowerUsername);
    const isStale = !cached ||
      cached.id !== identity.id ||
      cached.title !== identity.title ||
      cached.first_name !== identity.first_name ||
      cached.last_name !== identity.last_name;
    if (isStale) {
      // 只有真正的新 key（此前未见过这个 username）才会让缓存条数增长，
      // 才需要检查上限——同一 username 的信息更新（isStale 但 cached 存在）
      // 只是覆写既有条目，不占用新名额。
      if (!cached && userCache.size >= USER_CACHE_MAX) {
        // 超上限就淘汰最早插入的条目（Map 迭代顺序即插入顺序），不搞真
        // LRU——活跃用户反复发言不刷新位置，靠上限本身足够大兜底，见
        // consts/senderIdentity.ts 的 USER_CACHE_MAX 注释。
        userCache.delete(userCache.keys().next().value!);
      }
      userCache.set(lowerUsername, identity);
    }
  }

  return identity.id;
}

/**
 * 从 /copy 指令所回复的消息中解析出目标，这样即使对方没有公开 @username（或者
 * 机器人还没缓存过 TA，比如因为 privacy mode 屏蔽了 TA 之前的消息），只要能回复到
 * TA 的一条消息，依然可以将其设为目标。
 */
export function resolveReplyTarget(message: any): CachedUser | undefined {
  const repliedMessage: any = message.reply_to_message;
  if (!repliedMessage) return undefined;
  return resolveSenderIdentity(repliedMessage);
}

/** 按 @username 参数（不带 @，大小写不敏感）在缓存里查找目标，供
 *  /copy、/kick 等命令解析 @username 形式的目标，见
 *  commands/targetResolution.ts 的 resolveCommandTarget。 */
export function resolveUsernameTarget(username: string): CachedUser | undefined {
  return userCache.get(username.toLowerCase());
}

/**
 * 启动时把某个已知身份（当前正在被复读的目标，见 infra/storage.ts 的
 * GlobalCopyState）预热进缓存，让进程重启后立刻能用 /copy @username 重新
 * 指到 TA，不必等 TA 再发一条消息刷新缓存。见 index.ts 的 main()。
 */
export function seedSenderCache(user: CachedUser): void {
  if (!user.username) return;
  userCache.set(user.username.toLowerCase(), user);
}
