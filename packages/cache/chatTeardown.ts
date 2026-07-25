import type { ChatRuntimeOwner, ChatTeardownCallback } from "../types/chatTeardown";

/** 群 teardown 分发器（packages/infra/chatTeardown.ts）的内存状态。 */

const noChatTeardown: ChatTeardownCallback = (_chatId: number): undefined => undefined;

/** 上层运行态固定三个 owner 的 teardown；槽位数恒定，不随聊天或事件增长。 */
export const chatTeardownCallbacks: Record<ChatRuntimeOwner, ChatTeardownCallback> = {
  copy: noChatTeardown,
  aiChat: noChatTeardown,
  antiRaid: noChatTeardown,
};
