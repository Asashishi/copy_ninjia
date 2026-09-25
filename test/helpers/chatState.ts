import { createChatState } from "../../packages/libs/chatState";
import type { ChatState } from "../../packages/types/chatState";

/** 以规范形状（createChatState）为底覆盖指定字段，构造测试用群状态。 */
export function chatStateOf(overrides: Partial<ChatState> = {}): ChatState {
  return { ...createChatState(), ...overrides };
}
