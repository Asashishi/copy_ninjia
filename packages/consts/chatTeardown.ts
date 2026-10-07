import type { ChatRuntimeOwner } from "../types/chatTeardown";
import { exhaustiveList } from "./exhaustiveList";

/**
 * 群 teardown 的派发顺序，列全全部 owner。
 *
 * 全部回调在第一个 `await` 之前同步发出，使跨群 copy 槽、gag 会话、问答表单与
 * Worker 闸门一起关闭，随后才等待需要 durable 回执的异步 owner。`qa` 在 `gag` 之后，
 * 两者都只做进程内状态收尾；`joinLog` 在最后，只有一次投递加一次领域 flush。
 *
 * 新增 owner 时把它加进 `ChatRuntimeOwner` 就必须同时加到这里，否则编译不过。
 * 所属模块：infra/chatTeardown.ts 的 teardownChatRuntime。
 */
export const CHAT_TEARDOWN_ORDER: readonly ChatRuntimeOwner[] = exhaustiveList<ChatRuntimeOwner>()([
  "copy",
  "translate",
  "gag",
  "qa",
  "wed",
  "aiChat",
  "antiRaid",
  "joinLog",
]);
