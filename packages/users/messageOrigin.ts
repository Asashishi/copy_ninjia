import type { MessageOrigin } from "@grammyjs/types";

/**
 * 取得 Telegram 消息来源对应的稳定身份 id，供白名单预热与广告引用来源判定共用。
 * 隐藏用户只有显示名、没有可核对白名单的身份，因此返回 undefined 并按非白名单处理。
 */
export function messageOriginIdentityId(origin: MessageOrigin | undefined): number | undefined {
  if (origin === undefined || origin.type === "hidden_user") return undefined;
  if (origin.type === "user") return origin.sender_user.id;
  if (origin.type === "chat") return origin.sender_chat.id;
  return origin.chat.id;
}
