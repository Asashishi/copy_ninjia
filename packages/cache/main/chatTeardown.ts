import type {
  ChatRuntimeOwner,
  ChatTeardownCallback,
  ChatTeardownReason,
} from "../../types/chatTeardown";

/** 群 teardown 分发器（packages/infra/chatTeardown.ts）的内存状态。各 owner 注册时
 * 填充固定槽位，运行中不清除；进程退出时整表释放，重启后从 no-op 重新注册，
 * 不淘汰单个槽位。 */

const noChatTeardown: ChatTeardownCallback = (
  _chatId: number,
  _reason: ChatTeardownReason
): undefined => undefined;

/** 上层运行态固定五个 owner 的 teardown；槽位数恒定，不随聊天或事件增长。 */
export const chatTeardownCallbacks: Record<ChatRuntimeOwner, ChatTeardownCallback> = {
  copy: noChatTeardown,
  gag: noChatTeardown,
  aiChat: noChatTeardown,
  antiRaid: noChatTeardown,
  qa: noChatTeardown,
};
