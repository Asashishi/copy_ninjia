import type { CachedUser } from "../types/chatState";
import type { Message, User, Chat } from "grammy/types";
import { identityById, senderUsernameCache, userCache } from "../cache/main/senderIdentity";
import { USER_CACHE_MAX } from "../consts/senderIdentity";
import { explicitReplyTo } from "../libs/forumTopic";
import { channelIdentity, userIdentity, visibleSenderChat } from "./visibleSender";

/**
 * 消息发送者的身份解析与缓存。自动流程（packages/auto/message/ 靠 cacheSender
 * 刷新 username 缓存）和命令处理（packages/commands 下的 /copy、/block 靠
 * resolveReplyTarget 从被回复的消息定位目标，靠 resolveUsernameTarget 按
 * @username 定位目标）共用这一份逻辑。缓存状态见 cache/main/senderIdentity.ts。
 */

/**
 * 解析出一条消息发送者的 CachedUser 形态身份：可能是真实 Telegram 用户
 * （`from`），也可能是通过 `sender_chat` 或纯粹的 `channel_post`（这种情况下
 * 没有 `sender_chat`，帖子自身的 `chat` 就是该频道）体现的频道身份。既用于
 * 填充 username 缓存，也用于直接从被回复的消息中解析出 /copy 目标，以及为
 * 中文动作命令取出发起人身份（见 commands/cjkAction.ts）。
 */
export function resolveSenderIdentity(message: Message): CachedUser | undefined {
  const fromUser: User | undefined = message.from;
  const senderChat: Chat | undefined = visibleSenderChat(message);

  if (senderChat) {
    return channelIdentity(senderChat);
  } else if (fromUser) {
    return userIdentity(fromUser);
  }

  return undefined;
}

/**
 * 删除正向 alias，并仅在反向索引仍指向该 alias 时同步删除两份按 id 的记录。
 * 反向索引与 identityById 的键集恒等，因此两者必须在同一个条件分支里一起摘除。
 */
function deleteAlias(username: string): void {
  const cached: CachedUser | undefined = userCache.get(username);
  userCache.delete(username);
  if (cached && senderUsernameCache.get(cached.id) === username) {
    senderUsernameCache.delete(cached.id);
    identityById.delete(cached.id);
  }
}

/**
 * 原子维护 username <-> sender id 双向缓存，以及按 id 直查身份的 identityById。
 * 所有身份写入（消息观察与启动预热）都必须走这里；改名、去名、username 换绑
 * 和容量淘汰都在此同步维护各张表。
 *
 * identityById 的每一次写入和删除都紧贴同一条 senderUsernameCache 语句：两张表
 * 的键集恒等是 cacheSender 直查的前提。
 */
export function updateCachedIdentity(identity: CachedUser): void {
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
    identityById.delete(identity.id);
  }

  if (username === undefined) return;

  // 同一 username 被另一 sender 接管：旧 sender 不再拥有该 alias。
  const previousIdentity: CachedUser | undefined = userCache.get(username);
  if (previousIdentity && previousIdentity.id !== identity.id &&
    senderUsernameCache.get(previousIdentity.id) === username) {
    senderUsernameCache.delete(previousIdentity.id);
    identityById.delete(previousIdentity.id);
  }

  // 只有新增正向 key 才占容量，同名资料刷新和 username 换绑不增长条数。
  // 淘汰经 deleteAlias 连带摘掉 senderUsernameCache 与 identityById 两份按 id 的索引，
  // 不使用只维护单张 Map 的 libs/boundedMap.ts 的 setBoundedMapValue。
  if (!previousIdentity && userCache.size >= USER_CACHE_MAX) {
    const oldestUsername: string | undefined = userCache.keys().next().value;
    if (oldestUsername !== undefined) deleteAlias(oldestUsername);
  }

  userCache.set(username, identity);
  senderUsernameCache.set(identity.id, username);
  identityById.set(identity.id, identity);
}

/**
 * 记录/刷新某个发送者的缓存条目（两类身份见上方 resolveSenderIdentity），
 * 供 /copy @username 查找。没有公开 username 的发送者不入缓存
 * （见 CachedUser 注释），但仍可经 resolveReplyTarget 定位。
 * @returns 解析出的发送者 id（若以频道身份发送则为频道 id，否则为用户 id）。
 */
export function cacheSender(message: Message): number | undefined {
  const fromUser: User | undefined = message.from;
  const senderChat: Chat | undefined = visibleSenderChat(message);
  if (senderChat === undefined && fromUser === undefined) return undefined;
  const identityId: number = senderChat?.id ?? fromUser!.id;
  const username: string | undefined = senderChat !== undefined
    ? ("username" in senderChat ? senderChat.username : undefined)
    : fromUser!.username;
  // 直查按 id 的身份，不经 alias 再回查 userCache；两张表的键集恒等
  // （见 cache/main/senderIdentity.ts 的 identityById）。这条判定跑在每条群消息上。
  const cached: CachedUser | undefined = identityById.get(identityId);
  if (username === undefined && cached === undefined) {
    return identityId;
  }
  // 逐字段比对，不构造临时 CachedUser（每条群消息都走到这里）。两种身份形态
  // 缺席的字段也要比（频道没有 first/last_name，用户没有 title/isChannel）。
  // 字段清单必须与 resolveSenderIdentity 构造的两种形态一致，
  // 见 test/users/senderIdentity.test.ts 的形态同步用例。
  if (senderChat !== undefined) {
    const title: string | undefined = "title" in senderChat
      ? senderChat.title
      : undefined;
    if (
      cached?.id === identityId &&
      cached.username === username &&
      cached.first_name === undefined &&
      cached.last_name === undefined &&
      cached.title === title &&
      cached.isChannel === true
    ) {
      return identityId;
    }
  } else if (
    cached?.id === identityId &&
    cached.username === username &&
    cached.first_name === fromUser!.first_name &&
    cached.last_name === fromUser!.last_name &&
    cached.title === undefined &&
    cached.isChannel === undefined
  ) {
    return identityId;
  }

  // 只有确实要写入时才构造，且一律走 resolveSenderIdentity：两种身份形态的字面量
  // 只在 users/visibleSender.ts 的 channelIdentity / userIdentity 各一处，本文件与
  // commands/commandActor.ts 都调它们。这条路只在资料变化时才走到。
  const identity: CachedUser | undefined = resolveSenderIdentity(message);
  if (identity !== undefined) updateCachedIdentity(identity);
  return identityId;
}

/**
 * 从 /copy 指令所回复的消息中解析出目标；对方没有公开 @username 或尚未被缓存时，
 * 只要能回复到其一条消息即可定位。只认显式回复：论坛话题里 Bot API 自动填入的
 * 话题创建消息不算（见 libs/forumTopic.ts 的 explicitReplyTo）。
 */
export function resolveReplyTarget(message: Message): CachedUser | undefined {
  const repliedMessage: Message | undefined = explicitReplyTo(message);
  if (!repliedMessage) return undefined;
  return resolveSenderIdentity(repliedMessage);
}

/** 按 @username 参数（不带 @，大小写不敏感）在缓存里查找目标，供
 *  /copy、/block 等命令解析 @username 形式的目标，见
 *  commands/targetResolution.ts 的 resolveCommandTarget。 */
export function resolveUsernameTarget(username: string): CachedUser | undefined {
  const normalizedUsername: string = username.toLowerCase();
  const identity: CachedUser | undefined = userCache.get(normalizedUsername);
  if (!identity) return undefined;

  // 已知不一致的 alias 一律拒绝，并清除坏的正向记录；提示层建议回复消息定位。
  if (senderUsernameCache.get(identity.id) !== normalizedUsername) {
    userCache.delete(normalizedUsername);
    return undefined;
  }

  return identity;
}

/**
 * 按裸 id 取目标身份，供 `/block … enable`、`/block … disable`、`/gag`、`/ungag`、
 * `/permission` 与 `/white` 解析 id 形式的参数，见 commands/targetResolution.ts。
 *
 * **与 @username 那条路的差别：查不到不是失败。** id 本身就是权威目标，
 * 缓存只用来给回执配一个人类可读的标签；缓存落空时返回只带 id 的最小身份，
 * 命令照常执行（@username 目标的现查要求见 docs/cn/04-invariants.md）。
 *
 * 负数 id 一律标成频道身份：负 id 只来自 `sender_chat`，处置侧按同一符号分派
 * （见 workers/antiRaid/blocklistEffects.ts 的 removeOne）。`/block disable` 据此
 * 决定走 unbanChatSenderChat 还是 unbanChatMemberIfBanned。缓存命中那条路不重复标：
 * 负 id 的缓存条目都已带上 isChannel——消息观察一律经
 * resolveSenderIdentity 构造（cacheSender 与 resolveReplyTarget 都走它），启动预热的
 * updateCachedIdentity 写入的是持久化状态里原样保留该标记的身份。
 *
 * 双向一致才采信缓存里的那份，同 resolveUsernameTarget。
 */
export function resolveIdTarget(targetId: number): CachedUser {
  const minimalIdentity: CachedUser = targetId < 0 ? { id: targetId, isChannel: true } : { id: targetId };
  const normalizedUsername: string | undefined = senderUsernameCache.get(targetId);
  if (normalizedUsername === undefined) return minimalIdentity;
  const identity: CachedUser | undefined = userCache.get(normalizedUsername);
  return identity?.id === targetId ? identity : minimalIdentity;
}
