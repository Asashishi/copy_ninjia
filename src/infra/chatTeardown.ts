import { chatTeardownCallbacks } from "../cache/chatTeardown";
import type { ChatRuntimeOwner, ChatTeardownCallback } from "../types/chatTeardown";

/** 上层 owner 反向注册 teardown；本叶子注册表不静态依赖任何业务领域。 */
export function registerChatTeardown(owner: ChatRuntimeOwner, callback: ChatTeardownCallback): void {
  chatTeardownCallbacks[owner] = callback;
}

/** 执行指定 owner 当前注册的 teardown；未注册时是显式 no-op。 */
export function teardownRegisteredChat(owner: ChatRuntimeOwner, chatId: number): Promise<void> {
  return Promise.resolve(chatTeardownCallbacks[owner](chatId));
}
