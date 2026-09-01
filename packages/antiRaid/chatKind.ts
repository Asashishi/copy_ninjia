/**
 * 群类型的主线程观测口：把 `chat.type` 镜像给入群守卫线程。
 *
 * 为什么要镜像：踢人在 Worker 里执行，而它手上只有一个 `chatId: number`——状态机
 * 事件按设计只带最小字段。可「只踢不封」在两类群里是两个不同的 Bot API 方法
 * （见 workers/antiRaid/chatKind.ts 与 infra/telegram/actions/moderation.ts），
 * 判定必须有群类型。Worker 自己 `getChat` 一次的代价是每次踢人多一个请求，压在
 * 与踢人共用的限流队列上；按 id 前缀推断则是 Bot API 从未文档化的约定。
 *
 * 整表重放与 teardown 清理都在 workerBridge.ts（与权限镜像同一处），本模块只负责
 * 观测与去重。
 */

import { chatIsSupergroupById } from "../cache/main/antiRaid/chatKind";
import { postAntiRaid } from "./workerBridge";
import type { Chat } from "grammy/types";

/**
 * 记下并（仅在取值变化时）镜像一次群类型。
 *
 * 按值去重：群类型近乎恒定（只有普通群升级成超级群这一次单向跃迁），不去重的话
 * 每条群消息都要多投一条同值消息。
 *
 * **只认 `group` 与 `supergroup` 两个确定值，其余一律不记。** 私聊和频道本来就
 * 不走入群守卫；而「取值不认识」绝不能落成 `isSupergroup: false`——那是三态里
 * 唯一会改变行为的一档，写错的代价是在超级群里用 `banChatMember` 打出一次真正的
 * 持久封禁。没记就是未知，执行侧必须先反查，不能猜测（见 workers/antiRaid/chatKind.ts）。
 *
 * 投递失败不补偿也不记错误日志，理由同权限镜像：`postAntiRaid` 返回 false 只发生
 * 在 Worker 已放弃或正在重建时，而 onRespawn 会整表重放；为一次必然被重放覆盖的
 * 失败刷一行 error，只会把真正的故障淹掉。**但本地缓存照记**——它是重放的数据
 * 来源，漏记就等于这个群永远补不上。
 */
export function observeChatKind(chat: Pick<Chat, "id" | "type">): void {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const isSupergroup: boolean = chat.type === "supergroup";
  if (chatIsSupergroupById.get(chat.id) === isSupergroup) return;
  chatIsSupergroupById.set(chat.id, isSupergroup);
  postAntiRaid({ type: "chatKind", chatId: chat.id, isSupergroup });
}
