import type { CachedUser } from "../types/chatState";
import type { Message, User, Chat } from "@grammyjs/types";
import { senderUsernameCache, userCache } from "../cache/main/senderIdentity";
import { USER_CACHE_MAX } from "../consts/senderIdentity";
import { visibleSenderChat } from "./visibleSender";

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
  const cached: CachedUser | undefined = userCache.get(username);
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
  // 这里不能换成 libs/boundedMap.ts 的 setBoundedMapValue：淘汰要连带摘掉
  // senderUsernameCache 里的反向索引（deleteAlias），而共享实现只认识单张 Map，
  // 用它会留下一批指向已淘汰 username 的悬空反查项。
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
  const fromUser: User | undefined = message.from;
  const senderChat: Chat | undefined = visibleSenderChat(message);
  if (senderChat === undefined && fromUser === undefined) return undefined;
  const identityId: number = senderChat?.id ?? fromUser!.id;
  const username: string | undefined = senderChat !== undefined
    ? ("username" in senderChat ? senderChat.username : undefined)
    : fromUser!.username;
  const previousUsername: string | undefined =
    senderUsernameCache.get(identityId);
  if (username === undefined && previousUsername === undefined) {
    return identityId;
  }
  const cached: CachedUser | undefined = previousUsername === undefined
    ? undefined
    : userCache.get(previousUsername);
  // 逐字段比对而不是先构造一个 CachedUser 再比：每条群消息都会走到这里，绝大多数
  // 消息的发送者资料没变，构造一个只为比较的临时对象等于白付一次分配。两种身份形态
  // 缺席的字段也要比（频道没有 first/last_name，用户没有 title/isChannel），否则同一
  // id 在两种形态之间切换时会被误判成「未变」。字段清单必须与 resolveSenderIdentity
  // 构造的两种形态一致，见 test/users/senderIdentity.test.ts 的形态同步用例。
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

  // 只有确实要写入时才构造，且一律走 resolveSenderIdentity：两种身份形态的构造
  // 只此一处，不再各写一份可能悄悄漂移的字面量。这条路只在资料真的变了时才走到。
  const identity: CachedUser | undefined = resolveSenderIdentity(message);
  if (identity !== undefined) updateCachedIdentity(identity);
  return identityId;
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
 *  /copy、/block 等命令解析 @username 形式的目标，见
 *  commands/targetResolution.ts 的 resolveCommandTarget。 */
export function resolveUsernameTarget(username: string): CachedUser | undefined {
  const normalizedUsername: string = username.toLowerCase();
  const identity: CachedUser | undefined = userCache.get(normalizedUsername);
  if (!identity) return undefined;

  // 已知不一致的 alias 一律拒绝，并顺手清除坏的正向记录。/block 等破坏性命令
  // 因此不会继续相信仅存在于单边缓存中的陈旧身份；提示层会建议回复消息定位。
  if (senderUsernameCache.get(identity.id) !== normalizedUsername) {
    userCache.delete(normalizedUsername);
    return undefined;
  }

  return identity;
}

/**
 * 按裸 id 取目标身份，供 `/block`、`/unblock`、`/gag`、`/ungag`、
 * `/permission` 与 `/white` 解析 id 形式的参数，见 commands/targetResolution.ts。
 *
 * **与 @username 那条路的关键差别：查不到不是失败。** id 本身就是权威目标，
 * 缓存只用来给回执配一个人类可读的标签；而用户名是会被释放、被别人重新注册的
 * ——那正是「破坏性操作优先回复消息、别信历史用户名」这条建议的由来（同
 * `/steal_icon` 的现查要求，见 docs/cn/04-invariants.md）。按 id 下的命令没有这个
 * 问题，因此这里在缓存落空时返回只带 id 的最小身份，让命令照常执行。
 *
 * 负数 id 一律标成频道身份。这不是猜的：负 id 只可能来自 `sender_chat`，处置侧
 * 也早就按同一个符号分派（见 workers/antiRaid/blocklistEffects.ts 的 removeOne）。
 * 这个标记是承重的——`/unblock` 靠它决定走 unbanChatSenderChat 还是
 * unbanChatMemberIfBanned，漏标就会拿一个负数去调后者，报错记进 failedCount，
 * 管理员收到一份「还有 N 个群没解开」的假战报。缓存命中那条路不必重复标：
 * 负 id 的缓存条目只有两个来源，都已经带上 isChannel——消息观察一律经
 * resolveSenderIdentity 构造（cacheSender 与 resolveReplyTarget 都走它），启动预热的
 * seedSenderCache 写入的是持久化状态里原样保留该标记的身份。
 *
 * 双向一致才采信缓存里的那份，理由同 resolveUsernameTarget：单边残留的别名
 * 会把标签写成另一个人的名字。
 */
export function resolveIdTarget(targetId: number): CachedUser {
  const minimalIdentity: CachedUser = targetId < 0 ? { id: targetId, isChannel: true } : { id: targetId };
  const normalizedUsername: string | undefined = senderUsernameCache.get(targetId);
  if (normalizedUsername === undefined) return minimalIdentity;
  const identity: CachedUser | undefined = userCache.get(normalizedUsername);
  return identity?.id === targetId ? identity : minimalIdentity;
}

/**
 * 启动时把某个已知身份（当前正在被复读的目标，见 infra/storage/stateStore.ts 的
 * GlobalCopyState）预热进缓存，让进程重启后立刻能用 /copy @username 重新
 * 指到 TA，不必等 TA 再发一条消息刷新缓存。见 app/lifecycle.ts。
 */
export function seedSenderCache(user: CachedUser): void {
  updateCachedIdentity(user);
}
