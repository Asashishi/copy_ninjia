import { chatTeardownCallbacks } from "../cache/main/chatTeardown";
import type {
  ChatRuntimeOwner,
  ChatTeardownCallback,
  ChatTeardownReason,
} from "../types/chatTeardown";

/** 上层 owner 反向注册 teardown；本叶子注册表不静态依赖任何业务领域。 */
export function registerChatTeardown(owner: ChatRuntimeOwner, callback: ChatTeardownCallback): void {
  chatTeardownCallbacks[owner] = callback;
}

/** 执行指定 owner 当前注册的 teardown；未注册时是显式 no-op。 */
export function teardownRegisteredChat(
  owner: ChatRuntimeOwner,
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> {
  try {
    return Promise.resolve(chatTeardownCallbacks[owner](chatId, reason));
  } catch (error: unknown) {
    // owner 必须在调用栈内同步关闸；这里只把同步异常标准化为 rejected Promise，
    // 让组合 teardown 仍能启动其余 owner 并统一等待全部结果。
    const reason: Error = error instanceof Error
      ? error
      : new Error("Chat teardown callback threw a non-Error value.", { cause: error });
    return Promise.reject(reason);
  }
}
