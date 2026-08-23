import type { ChatRuntimeOwner } from "../types/chatTeardown";

/**
 * 编译期穷尽校验：顺序表必须覆盖 `ChatRuntimeOwner` 的每一个成员，漏掉任何一个
 * 都会让参数类型退化成 `never`，在调用点当场报错。
 *
 * 单写一个函数而不是直接给数组标注 `readonly ChatRuntimeOwner[]`：后者只保证
 * 每一项合法，**不保证一项都不少**。`infra/botAdmin.ts` 的组合 teardown 此前正是
 * 手写了五个 owner 里的四个，漏掉的 `qa` 让 `/set_qa` 表单在停管后继续留在群里，
 * 而 lint、typecheck 与约定自检都看不出来（见 docs/cn/04-invariants.md 的群 teardown）。
 */
function completeOwnerOrder<T extends readonly ChatRuntimeOwner[]>(
  owners: T & ([ChatRuntimeOwner] extends [T[number]] ? unknown : never)
): T {
  return owners;
}

/**
 * 群 teardown 的派发顺序，一次列全全部 owner。
 *
 * 顺序是承重的：全部回调必须在第一个 `await` 之前同步发出，让跨群 copy 槽、
 * gag 会话、问答表单与两条 Worker 闸门一起关掉，随后才等待需要 durable 回执的
 * 异步 owner。`qa` 排在 `gag` 之后：两者都只做进程内状态收尾，不产生远端等待。
 *
 * 新增 owner 时把它加进 `ChatRuntimeOwner` 就必须同时加到这里，否则编译不过。
 * 所属模块：infra/botAdmin.ts 的 teardownChatRuntime。
 */
export const CHAT_TEARDOWN_ORDER: readonly ChatRuntimeOwner[] = completeOwnerOrder([
  "copy",
  "gag",
  "qa",
  "aiChat",
  "antiRaid",
] as const);
