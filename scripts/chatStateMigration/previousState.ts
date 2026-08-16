/** 最近已发布版本 8.1.1 的群状态严格解码；仅供一次性冷迁移。 */

import { decodeChatStateData } from "../../packages/database/codec/chatState";
import { createChatState } from "../../packages/libs/chatState";
import { isPlainRecord } from "../../packages/libs/record";
import type { ChatState } from "../../packages/types/chatState";

/** 上一发布版群状态解码结果；旧管理员布尔值必须由 Telegram 完整权限替换。 */
export interface PreviousChatState {
  readonly state: ChatState;
  readonly botIsAdmin: boolean | undefined;
}

/**
 * 严格读取 8.1.1 的 `botIsAdmin` 字段，同时允许已经补齐 `botPermissions` 的迁移
 * 准备态。两者不得并存；其它字段继续复用当前严格 codec，避免两套校验漂移。
 */
export function decodePreviousChatState(
  value: unknown,
  source: string
): PreviousChatState {
  if (!isPlainRecord(value)) {
    throw new Error(`${source}: $ must be a chat-state object.`);
  }
  const hasPreviousPermissions: boolean = "botIsAdmin" in value;
  if (hasPreviousPermissions && "botPermissions" in value) {
    throw new Error(
      `${source}: $.botIsAdmin and $.botPermissions must not coexist.`
    );
  }
  const previousValue: unknown = value.botIsAdmin;
  if (hasPreviousPermissions && typeof previousValue !== "boolean") {
    throw new Error(`${source}: $.botIsAdmin must be a boolean when present.`);
  }

  const projected: Record<string, unknown> = { ...value };
  delete projected.botIsAdmin;
  const state: ChatState = Object.keys(projected).length === 0
    ? createChatState()
    : decodeChatStateData(JSON.stringify(projected), source);
  return {
    state,
    botIsAdmin: hasPreviousPermissions ? previousValue as boolean : undefined,
  };
}
