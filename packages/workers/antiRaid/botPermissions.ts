/**
 * 机器人自身权限位在入群守卫线程侧的读写口。
 *
 * 观测发生在主线程（`my_chat_member` 更新与按需 `getChatMember` 现查都只到那边），
 * 执行发生在本线程（踢人、禁言、删消息都走 joinVerificationApi）。两边因此按
 * 变更镜像：主线程每次确证或作废都发一条 `botPermissionsChanged`，Worker 重建与
 * 进程启动时整表重放（见 packages/antiRaid/index.ts）。
 *
 * 读出来的是三态。**「没观测到」不是「观测到没有」**：主线程对撤管理员、离群、
 * `/init` 切换和现查失败发的都是同一条「权限未知」，而这四件事里只有前三件能
 * 断定做不了。因此这里只如实转述镜像内容，由调用方决定未知那一档怎么办——
 * 目前刷屏禁言的选择是照常尝试、让 Telegram 当裁判（见 floodControl.ts）。
 */

import { workerBotChatPermissions } from "../../cache/workers/antiRaid/botPermissions";
import type { BotChatPermissions } from "../../types/telegram";

/** 应用一条主线程镜像过来的权限变化；permissions 为 undefined 表示此刻未知。 */
export function applyBotPermissionsChange(chatId: number, permissions: BotChatPermissions | undefined): void {
  if (permissions === undefined) {
    workerBotChatPermissions.delete(chatId);
    return;
  }
  workerBotChatPermissions.set(chatId, permissions);
}

/**
 * 机器人此刻能不能在这个群限制成员（禁言/封禁）。
 *
 * **三态，调用方必须把 undefined 与 false 分开**：前者是「没观测到」，后者是
 * 「观测到不行」。把它们压成一个布尔看着省事，代价是两种相反的处置只能取其一
 * ——要么把未知当没权限（现查撞上一次 429 就等于那 5 分钟退避里刷屏无人处置，
 * 日志里还写着一句不准确的「没有权限」），要么把未知当有权限（在一个真的没
 * 权限的群里反复打注定失败的请求）。分开之后才能各按各的办：确证没有就别打，
 * 没观测到就让 Telegram 当裁判（见 floodControl.ts 的兜底）。
 * @returns 确证有 true、确证没有 false、没观测到 undefined。
 */
export function botCanRestrictIn(chatId: number): boolean | undefined {
  return workerBotChatPermissions.get(chatId)?.canRestrictMembers;
}

/** 机器人此刻能不能在这个群删别人的消息；三态语义同 botCanRestrictIn。 */
export function botCanDeleteIn(chatId: number): boolean | undefined {
  return workerBotChatPermissions.get(chatId)?.canDeleteMessages;
}

/** 停管/`/init disable`/群 teardown：丢掉这个群的权限镜像。 */
export function forgetWorkerBotPermissions(chatId: number): void {
  workerBotChatPermissions.delete(chatId);
}

/** Worker stop/测试隔离时清空整表；重建后由主线程重放。 */
export function resetWorkerBotPermissions(): void {
  workerBotChatPermissions.clear();
}
