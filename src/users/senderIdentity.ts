import type { CachedUser } from "../types";

/**
 * 消息发送者的身份解析与缓存。自动流程（src/auto/message.ts 靠 cacheSender
 * 刷新 username 缓存）和命令处理（src/commands 下的 /copy、/kick 靠
 * resolveReplyTarget 从被回复的消息定位目标）共用这一份逻辑。
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
 * 记录/刷新某个发送者的缓存条目（真实 Telegram 用户，或通过 sender_chat /
 * channel_post 体现的频道身份），以便之后 /copy @username 能找到 TA。没有公开
 * username 的发送者不会被缓存在这里（该 map 以 username 为键），但仍可以通过
 * resolveReplyTarget 被定位为目标。
 * @returns 解析出的发送者 id（若以频道身份发送则为频道 id，否则为用户 id）。
 */
export function cacheSender(message: any, users: Record<string, CachedUser>): number | undefined {
  const identity = resolveSenderIdentity(message);
  if (!identity) return undefined;

  if (identity.username) {
    const lowerUsername: string = identity.username.toLowerCase();
    const cached = users[lowerUsername];
    const isStale = !cached ||
      cached.id !== identity.id ||
      cached.title !== identity.title ||
      cached.first_name !== identity.first_name ||
      cached.last_name !== identity.last_name;
    if (isStale) {
      users[lowerUsername] = identity;
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
