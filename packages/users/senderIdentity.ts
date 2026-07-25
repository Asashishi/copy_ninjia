import type { CachedUser } from "../types/chatState";
import type { Message } from "@grammyjs/types";
import { senderUsernameCache, userCache } from "../cache/senderIdentity";
import { USER_CACHE_MAX } from "../consts/senderIdentity";
import { visibleSenderChat } from "./visibleSender";

/**
 * 消息发送者的身份解析与缓存。自动流程（packages/auto/message/ 靠 cacheSender
 * 刷新 username 缓存）和命令处理（packages/commands 下的 /copy、/kick 靠
 * resolveReplyTarget 从被回复的消息定位目标，靠 resolveUsernameTarget 按
 * @username 定位目标）共用这一份逻辑。缓存状态见 cache/senderIdentity.ts。
 */

/**
 * 解析出一条消息发送者的 CachedUser 形态身份：可能是真实 Telegram 用户
 * （`from`），也可能是通过 `sender_chat` 或纯粹的 `channel_post`（这种情况下
 * 没有 `sender_chat`，帖子自身的 `chat` 就是该频道）体现的频道身份。既用于
 * 填充 username 缓存，也用于直接从被回复的消息中解析出 /copy 目标。
 */
function resolveSenderIdentity(message: Message): CachedUser | undefined {
  const fromUser = message.from;
  const senderChat = visibleSenderChat(message);

  if (senderChat) {
    return {
      id: senderChat.id,
      username: "username" in senderChat ? senderChat.username : undefined,
      title: "title" in senderChat ? senderChat.title : undefined,
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

/** 删除正向 alias，并仅在反向索引仍指向该 alias 时同步删除反向记录。 */
function deleteAlias(username: string): void {
  const cached = userCache.get(username);
  userCache.delete(username);
  if (cached && senderUsernameCache.get(cached.id) === username) {
    senderUsernameCache.delete(cached.id);
  }
}

/**
 * 原子维护 username <-> sender id 双向缓存。所有身份写入（消息观察与启动预热）
 * 都必须走这里，避免改名、去名、username 换绑和容量淘汰产生悬空映射。
 */
function updateCachedIdentity(identity: CachedUser): void {
  const username: string | undefined = identity.username
    ? identity.username.toLowerCase()
    : undefined;
  const previousUsername: string | undefined = senderUsernameCache.get(identity.id);

  // 同一 sender 改名或移除 username：先撤销只属于 TA 的旧 alias。
  if (previousUsername !== undefined && previousUsername !== username) {
    if (userCache.get(previousUsername)?.id === identity.id) {
      userCache.delete(previousUsername);
    }
    senderUsernameCache.delete(identity.id);
  }

  if (username === undefined) return;

  // 同一 username 被另一 sender 接管：旧 sender 不再拥有该 alias。
  const previousIdentity: CachedUser | undefined = userCache.get(username);
  if (previousIdentity && previousIdentity.id !== identity.id &&
    senderUsernameCache.get(previousIdentity.id) === username) {
    senderUsernameCache.delete(previousIdentity.id);
  }

  // 只有新增正向 key 才占容量。同名资料刷新和 username 换绑都不增长条数。
  if (!previousIdentity && userCache.size >= USER_CACHE_MAX) {
    const oldestUsername: string | undefined = userCache.keys().next().value;
    if (oldestUsername !== undefined) deleteAlias(oldestUsername);
  }

  userCache.set(username, identity);
  senderUsernameCache.set(identity.id, username);
}

/**
 * 记录/刷新某个发送者的缓存条目（两类身份见上方 resolveSenderIdentity），
 * 以便之后 /copy @username 能找到 TA。没有公开 username 的发送者不入缓存
 * （见 CachedUser 注释），但仍可经 resolveReplyTarget 定位。
 * @returns 解析出的发送者 id（若以频道身份发送则为频道 id，否则为用户 id）。
 */
export function cacheSender(message: Message): number | undefined {
  const identity = resolveSenderIdentity(message);
  if (!identity) return undefined;

  updateCachedIdentity(identity);

  return identity.id;
}

/**
 * 从 /copy 指令所回复的消息中解析出目标，这样即使对方没有公开 @username（或者
 * 机器人还没缓存过 TA，比如因为 privacy mode 屏蔽了 TA 之前的消息），只要能回复到
 * TA 的一条消息，依然可以将其设为目标。
 */
export function resolveReplyTarget(message: Message): CachedUser | undefined {
  const repliedMessage: Message | undefined = message.reply_to_message;
  if (!repliedMessage) return undefined;
  return resolveSenderIdentity(repliedMessage);
}

/** 按 @username 参数（不带 @，大小写不敏感）在缓存里查找目标，供
 *  /copy、/kick 等命令解析 @username 形式的目标，见
 *  commands/targetResolution.ts 的 resolveCommandTarget。 */
export function resolveUsernameTarget(username: string): CachedUser | undefined {
  const normalizedUsername: string = username.toLowerCase();
  const identity: CachedUser | undefined = userCache.get(normalizedUsername);
  if (!identity) return undefined;

  // 已知不一致的 alias 一律拒绝，并顺手清除坏的正向记录。/kick 等破坏性命令
  // 因此不会继续相信仅存在于单边缓存中的陈旧身份；提示层会建议回复消息定位。
  if (senderUsernameCache.get(identity.id) !== normalizedUsername) {
    userCache.delete(normalizedUsername);
    return undefined;
  }

  return identity;
}

/**
 * 启动时把某个已知身份（当前正在被复读的目标，见 infra/storage/stateStore.ts 的
 * GlobalCopyState）预热进缓存，让进程重启后立刻能用 /copy @username 重新
 * 指到 TA，不必等 TA 再发一条消息刷新缓存。见 app/lifecycle.ts。
 */
export function seedSenderCache(user: CachedUser): void {
  updateCachedIdentity(user);
}
