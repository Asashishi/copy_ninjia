import type { Chat, Message } from "@grammyjs/types";

/**
 * 群内实际展示的发送者会话：sender_chat（频道马甲/匿名管理员）优先；纯粹的
 * 频道帖（channel_post）没有 sender_chat，帖子自身的 chat 就是该频道；两者
 * 都不是则返回 undefined（发送者是真实用户 from，或彻底拿不到）。
 * 匿名管理员以当前群组身份发言时，sender_chat.id 会等于 message.chat.id；
 * 这里有意保留该身份，/copy 需要据此复制群头像并匹配后续皮套消息进行复读。
 * Telegram 不会暴露皮套背后的真实用户，破坏性操作必须由调用方单独拦截。
 * auto/message/facts.ts 的转录身份与 users/senderIdentity.ts 的缓存身份共用
 * 这一条判定，避免两处各写一份后悄悄漂移。
 */
export function visibleSenderChat(message: Message): Chat | undefined {
  return message.sender_chat ?? (message.chat.type === "channel" ? message.chat : undefined);
}
