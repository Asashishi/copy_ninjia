import type { Chat, Message } from "grammy/types";
import type { TelegramIdentityMetadata } from "../types/identityPolicy";

/** 把消息当前展示的用户或频道身份映射为持久化名单使用的固定字段。 */
export function messageIdentityMetadata(
  message: Message,
  senderChat: Chat | undefined
): Readonly<TelegramIdentityMetadata> {
  return senderChat === undefined
    ? {
      firstName: message.from?.first_name ?? "",
      lastName: message.from?.last_name ?? "",
      username: message.from?.username ?? "",
    }
    : {
      firstName: "title" in senderChat ? senderChat.title ?? "" : "",
      lastName: "",
      username: "username" in senderChat ? senderChat.username ?? "" : "",
    };
}
