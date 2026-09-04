import { CHAT_TEARDOWN_ORDER } from "../consts/chatTeardown";
import { clearChatStateField } from "./storage/stateStore";
import { teardownRegisteredChat } from "./chatTeardownRegistry";
import type { ChatTeardownReason } from "../types/chatTeardown";

/** 配置去留由调用入口决定；这里只停止 owner、取消计时器并发起权限恢复。 */
export async function teardownChatRuntime(
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> {
  // 代理入口与全部 owner 必须在第一个 await 前同步关闸；异步 owner 随后统一等待。
  clearChatStateField(chatId, "isProxySendEnabled");
  const teardowns: Promise<void>[] = [];
  for (const owner of CHAT_TEARDOWN_ORDER) {
    teardowns.push(teardownRegisteredChat(owner, chatId, reason));
  }
  const results: PromiseSettledResult<void>[] = await Promise.allSettled(teardowns);
  const failures: unknown[] = results.flatMap(
    (result: PromiseSettledResult<void>): unknown[] => result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `Chat runtime teardown failed for chat ${chatId}.`);
  }
}
