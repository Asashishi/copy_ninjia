/**
 * 群类型的主线程观测口：把 `chat.type` 镜像给入群守卫线程，供踢人分派「只踢
 * 不封」时选择对应的 Bot API 方法（见 workers/antiRaid/chatKind.ts 与
 * infra/telegram/actions/moderation.ts）。
 *
 * 权威线程为主线程，取值变化时增量推送；Worker 重建后由 workerBridge/replay.ts
 * 整表重放，teardown 清理见 workerBridge/observers.ts。本模块只负责观测与去重。
 */

import { chatIsSupergroupById } from "../cache/main/antiRaid/chatKind";
import { getChatState } from "../infra/storage/stateStore";
import { postAntiRaid } from "./workerBridge/controller";
import type { Chat } from "grammy/types";

/**
 * 记下并（仅在取值变化时）镜像一次群类型。
 *
 * 只认 `group` 与 `supergroup` 两个确定值，其余一律不记；「取值不认识」不得落成
 * `isSupergroup: false`，没记就是未知，执行侧必须先反查（判定见
 * workers/antiRaid/chatKind.ts）。只保留已经 `/init enable` 的群；首次启用由命令在
 * 落盘后补一次观测，被容量门禁拒绝的 `/init` 不留下镜像。
 *
 * 投递失败不补偿也不记错误日志：`postAntiRaid` 返回 false 只发生在 Worker 已放弃
 * 或正在重建时，onRespawn 会整表重放。本地缓存仍需写入——它是重放的数据来源。
 */
export function observeChatKind(chat: Pick<Chat, "id" | "type">): void {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const isSupergroup: boolean = chat.type === "supergroup";
  if (chatIsSupergroupById.get(chat.id) === isSupergroup) return;
  if (getChatState(chat.id).isInitEnabled !== true) return;
  chatIsSupergroupById.set(chat.id, isSupergroup);
  postAntiRaid({ type: "chatKind", chatId: chat.id, isSupergroup });
}
