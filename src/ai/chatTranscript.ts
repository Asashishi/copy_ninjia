import type { BufferedMessage } from "../types";
import { FALLBACK_SPEAKER_NAME } from "../consts/auto";

/** 发言人的显示名：first/last 拼接，都没有则给个占位。 */
export function displayBufferedMessageName(message: BufferedMessage): string {
  return [message.firstName, message.lastName].filter((part: string) => !!part).join(" ").trim() || FALLBACK_SPEAKER_NAME;
}

/**
 * 把一条缓存消息格式化成喂给模型的一行：先拼记录时已格式化好的发送时间，
 * 再标出 id 避免重名混淆身份；有公开 username 时额外给出映射，让模型能把
 * 消息正文里的 @username 认回具体发言人。旧缓存没有 username 时保持原格式。
 */
export function formatBufferedMessageLine(message: BufferedMessage): string {
  const usernameTag: string = message.username ? ` [username:@${message.username.replace(/^@+/, "")}]` : "";
  return `[${message.at}] [id:${message.id}]${usernameTag} ${displayBufferedMessageName(message)}：${message.text}`;
}
