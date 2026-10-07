import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";

import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { logger } from "../infra/logger";
import {
  disableChatStateSwitch,
  getChatState,
  getChatStateCache,
  getOrCreateChatState,
  persistChatState,
  purgeChatStateExceptLockdown,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg, toggleReplyText } from "./superAdminToggle";
import { invalidateBotAdminStatus, resolveBotAdminStatus } from "../infra/botAdmin";
import { teardownChatRuntime } from "../infra/chatTeardown";
import { observeChatKind } from "../antiRaid/chatKind";

/**
 * 处理 /init enable|disable 指令：按群开关机器人是否处理这个群的更新（见
 * ChatState.isInitEnabled）。禁用/未初始化的群，其更新在 infra/updateGate.ts 的
 * shouldPassInitGate 处丢弃（接线见 app/registerHandlers.ts），不进入监听、复读、AI 等链路。
 * 只有超级管理员可以控制这个总开关。
 *
 * enable 落盘后调用 observeChatKind 补齐群类型镜像；未纳管的新群在已管群数达到
 * STATE_MANAGED_CHAT_LIMIT 时拒绝启用。disable 先落盘总开关，再经 teardownChatRuntime
 * 拆除运行时并删除该群的 chat_states 条目（lockdown 除外）。
 */
export async function handleInitCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    texts: chatAtmosphere().INIT_TOGGLE_TEXTS,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const knownChats: ReadonlyMap<number, ChatState> = getChatStateCache();
  if (
    arg === "enable" &&
    !knownChats.has(chatId) &&
    knownChats.size >= STATE_MANAGED_CHAT_LIMIT
  ) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().INIT_CHAT_LIMIT_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }
  const wasEnabled: boolean = getChatState(chatId).isInitEnabled === true;
  const isEnabled: boolean = arg === "enable";
  // 只有 enable 建条目。disableChatStateSwitch 对没有条目的群是 no-op，随后的
  // persistChatState 仍写出删除墓碑，重复 disable 仍会重跑清理。
  if (isEnabled) getOrCreateChatState(chatId).isInitEnabled = true;
  else disableChatStateSwitch(chatId, "isInitEnabled");
  // 对已经启用的群重复 /init enable 不作废管理员状态记录；其余情形（含 disable）一律作废。
  if (!(isEnabled && wasEnabled)) invalidateBotAdminStatus(chatId);
  // 落盘先于运行时拆除，与 commands/superAdminToggle.ts 的 runChatToggleCommand
  // 同序：teardownChatRuntime 含不可逆的持久化动作（aiChat owner 的 durable 记忆
  // 删除、translate owner 的会话删除）。
  //
  // 这一次落盘失败原样上抛：那是 fatal durability failure，这条 update 不确认
  // （见 docs/cn/04-invariants.md）。
  await persistChatState(chatId, "init toggled");
  if (isEnabled) observeChatKind(ctx.chat);

  // 拆运行态失败不上抛：总开关此前已 durable 地关掉；就地降级为记一行错误日志，
  // 回执改用 INIT_DISABLE_TEARDOWN_FAILED_TEXT。
  let teardownFailed: boolean = false;
  if (arg === "disable") {
    try {
      await teardownChatRuntime(chatId, "explicitDisable");
      // 拆完才删这一行：本群的 AI 记忆、`/wed` 奖池、入群日志与问答都由各 owner
      // 在 teardownChatRuntime 里删掉，`chat_states` 条目最后删除，排在总开关
      // durable 落盘之后。
      //
      // 功能开关与配置一并删掉，lockdown 除外（解锁流程仍要用它）。
      purgeChatStateExceptLockdown(chatId);
      // 无条件补这一次落盘：teardownChatRuntime 清掉的 isProxySendEnabled 与
      // 上面的整行删除都只动内存。整条状态回到缺省时这次写出的是删除墓碑，
      // SQLite 行一并消失（见 infra/chatStateStorage.ts 的 encodeCurrentChatState）。
      //
      // 这一次与拆除一起降级：失败按「有几样没拆干净」回执，不上抛。
      await persistChatState(chatId, "init teardown settled");
    } catch (error: unknown) {
      teardownFailed = true;
      logger.error(
        `Failed to settle the chat runtime teardown for chat ${chatId}; ` +
        "the init gate is already persisted as disabled:",
        error
      );
    }
  }

  // enable 之后若 botPermissions 为空，重新判定一次管理员身份：现查经
  // recordBotChatPermissions 回填，「是管理员 && 已初始化」这个合取因本次 enable
  // 成立时触发一次黑名单清扫（见 infra/botAdmin.ts）。
  //
  // 条件取「botPermissions 此刻为空」而不是 !wasEnabled；这次调用可能上抛
  // （getChatMember 之后的状态落盘失败，见 infra/botAdmin.ts 与
  // docs/cn/04-invariants.md），重投时 wasEnabled 已为 true，权限记录仍为空。
  // 记录已知的重复 enable 跳过。
  if (isEnabled && getChatState(chatId).botPermissions === undefined) await resolveBotAdminStatus(chatId);

  const replyText: string = teardownFailed
    ? chatAtmosphere().INIT_DISABLE_TEARDOWN_FAILED_TEXT
    : toggleReplyText({
      isEnabled,
      wasEnabled,
      texts: chatAtmosphere().INIT_TOGGLE_TEXTS,
    });
  await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
