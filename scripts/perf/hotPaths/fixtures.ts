/**
 * 各热点场景共用的基准夹具：固定的群 id、时间戳起点与一份最小消息。
 *
 * 跨场景组共用（hotPaths/ 下各领域场景文件）；各场景文件从这里取夹具，不互相 import。
 */

import type { ChatMemberAdministrator, Message, UserFromGetMe } from "grammy/types";

/** 基准群聊 id；仅用于进程内 Map，不产生任何 Telegram 或磁盘副作用。 */
export const BENCHMARK_CHAT_ID: number = -100_000_000_000_001;
/**
 * 所有时间戳场景的起点（毫秒）。
 *
 * 取 `Date.now()` 同量级的值，超出 int32，使数值表示与 JIT 输入形态与生产一致；
 * 固定值使各次运行可复现，同一热函数在预热与正式循环之间不切换数值表示。
 */
export const BENCHMARK_EPOCH_MS: number = 1_767_225_600_000;

/**
 * 基准发送者 id，取真实 Telegram 用户 id 的量级，超出 int32。
 *
 * 数值表示影响 JSC 的 Map 键、比较与跨函数传递，判读时连同输入量级一起核对，
 * 见 `BENCHMARK_EPOCH_MS`。同一场景要多个不同发送者时按 `+1` 递增。
 */
export const BENCHMARK_SENDER_ID: number = 7_123_456_789;

/**
 * 一条普通用户消息。`senderId` 在同一场景要喂多个不同发送者时传入；
 * 同 id 换 username 会被 cacheSender 判成改名并走写入路径。
 */
export function messageFixture(
  username?: string,
  senderId: number = BENCHMARK_SENDER_ID
): Message {
  return {
    message_id: 1,
    date: 1,
    chat: {
      id: BENCHMARK_CHAT_ID,
      type: "supergroup",
      title: "Performance fixture",
    },
    from: {
      id: senderId,
      is_bot: false,
      first_name: "Stable",
      last_name: "Sender",
      username,
    },
  };
}

/**
 * 频道马甲 / 匿名管理员皮套发的那条消息：只有 `sender_chat`，没有 `from`。
 *
 * 与 `messageFixture` 配对使用，两种身份形态混着到达同一个调用点；两种形态在
 * `users/senderIdentity.ts` 的 `resolveSenderIdentity` 里各产出一个 `CachedUser`
 * shape。`index` 区分不同频道。
 */
export function channelMessageFixture(index: number, username?: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat: {
      id: BENCHMARK_CHAT_ID,
      type: "supergroup",
      title: "Performance fixture",
    },
    sender_chat: {
      id: -1_000_000_000_000 - index,
      type: "channel",
      title: `Channel ${index}`,
      username,
    },
  };
}

/** 注册链与成员观察共用的罐头机器人身份。 */
export const BENCHMARK_BOT_INFO: Readonly<UserFromGetMe> = {
  id: 1, is_bot: true, first_name: "perf", username: "perf_bot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: true,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

/**
 * 本机器人在基准群里的管理员身份，喂给 `readBotChatPermissions` 生成权限快照。
 *
 * 各条 ingress 的稳定态判定以它为前提（见 registeredMiddlewareScenario.ts 的场景头注）。
 * 权限逐项给定，不留未知。
 */
export const BENCHMARK_BOT_ADMIN_MEMBER: Readonly<ChatMemberAdministrator> = {
  status: "administrator",
  user: BENCHMARK_BOT_INFO,
  can_be_edited: false,
  is_anonymous: false,
  can_manage_chat: true,
  can_delete_messages: true,
  can_manage_video_chats: true,
  can_restrict_members: true,
  can_promote_members: false,
  can_change_info: true,
  can_invite_users: true,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_send_welcome_messages: false,
};
