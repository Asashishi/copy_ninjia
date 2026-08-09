/**
 * 群类型在入群守卫线程侧的读写口。
 *
 * 观测发生在主线程（每条 update 都带 `chat.type`），执行发生在本线程（踢人走
 * joinVerificationApi）。两边因此按变更镜像：主线程每次观测到新值就发一条
 * `chatKind`，Worker 重建与进程启动时整表重放（见 packages/antiRaid/workerBridge.ts）。
 *
 * 读出来的是三态。**「没观测到」不是「是普通群」**：镜像到达之前、或这个群从未
 * 有过一条被本进程处理的 update 时都读不到值，而绝大多数托管群是超级群。把未知
 * 折算成普通群，就会在超级群里用 `banChatMember` 打出一次真正的持久封禁——而
 * 「除 /block 与黑名单秒踢外一律只踢不封」是这套自动处置的硬约束。
 *
 * 冷启动时主线程镜像也可能为空；终态执行前会用 getChat 按群复用反查，查不出
 * 类型就保留终态退避，绝不拿「未知」猜一个破坏性 API。
 */

import type { ChatFullInfo } from "@grammyjs/types";
import { VERIFICATION_CHAT_KIND_FETCH_MAX } from "../../consts/antiRaid/verification";
import {
  workerChatIsSupergroup,
  workerChatKindFetches,
} from "../../cache/workers/antiRaid/chatKind";
import { joinVerificationApi } from "../../infra/telegram";
import { logger } from "../../infra/logger";

/** 应用一条主线程镜像过来的群类型变化。 */
export function applyChatKindChange(chatId: number, isSupergroup: boolean): void {
  workerChatKindFetches.delete(chatId);
  workerChatIsSupergroup.set(chatId, isSupergroup);
}

/**
 * 这个群此刻是不是超级群。
 * @returns 确证是 true、确证不是 false、没观测到 undefined。
 */
export function chatIsSupergroup(chatId: number): boolean | undefined {
  return workerChatIsSupergroup.get(chatId);
}

/**
 * 读取群类型；镜像缺失时由执行线程直接 getChat，并让同群终态复用在途请求。
 * @returns 只返回确证值；查询失败、非群聊或并发已满均返回 undefined。
 */
export function resolveChatIsSupergroup(
  chatId: number
): Promise<boolean | undefined> {
  const known: boolean | undefined = workerChatIsSupergroup.get(chatId);
  if (known !== undefined) return Promise.resolve(known);
  const existing: Promise<boolean | undefined> | undefined =
    workerChatKindFetches.get(chatId);
  if (existing !== undefined) return existing;
  if (workerChatKindFetches.size >= VERIFICATION_CHAT_KIND_FETCH_MAX) {
    return Promise.resolve(undefined);
  }
  const task: Promise<boolean | undefined> = joinVerificationApi.getChat(chatId)
    .then((chat: ChatFullInfo): boolean | undefined => {
      // 主线程镜像可能在查询期间到达。迟到请求不得覆盖它，但当前等待者可以直接
      // 使用那份更新值，避免无谓地再退避一个终态周期。
      if (workerChatKindFetches.get(chatId) !== task) {
        return workerChatIsSupergroup.get(chatId);
      }
      if (chat.type !== "group" && chat.type !== "supergroup") {
        logger.error(`Chat kind lookup for chat ${chatId} returned a non-group chat.`);
        return undefined;
      }
      const isSupergroup: boolean = chat.type === "supergroup";
      workerChatIsSupergroup.set(chatId, isSupergroup);
      return isSupergroup;
    })
    .catch((error: unknown): undefined => {
      logger.error(`Failed to resolve chat kind for chat ${chatId}:`, error);
      return undefined;
    })
    .finally((): void => {
      if (workerChatKindFetches.get(chatId) === task) {
        workerChatKindFetches.delete(chatId);
      }
    });
  workerChatKindFetches.set(chatId, task);
  return task;
}

/** 停管/`/init disable`/群 teardown：丢掉这个群的群类型镜像。 */
export function forgetWorkerChatKind(chatId: number): void {
  workerChatKindFetches.delete(chatId);
  workerChatIsSupergroup.delete(chatId);
}

/** Worker stop/测试隔离时清空整表；重建后由主线程重放。 */
export function resetWorkerChatKind(): void {
  workerChatKindFetches.clear();
  workerChatIsSupergroup.clear();
}
