/**
 * Telegram 群与频道 ID 的共享领域判定。私聊用户 ID 为正数，群、超级群与
 * 频道 ID 为负数；持久化的群级状态不得把两者混用。
 */
export function isTelegramGroupChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}
