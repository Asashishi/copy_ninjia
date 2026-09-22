import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";

import { sendCommandMessage, unbanChatMemberIfBanned, unbanChatSenderChat } from "../infra/telegram";
import { formatTargetLabel } from "../users/userLabel";
import { resolveCommandTarget } from "./targetResolution";
import { rejectUnlessPermitted } from "./commandActor";
import { resolveBotAdminStatus } from "../infra/botAdmin";
import {
  confirmBlocklistPersisted,
  managedAdminChatIds,
  runManagedChatBatch,
  unblockUser,
} from "../infra/blocklist/membership";
import type { ManagedChatOutcome } from "../infra/blocklist/membership";
import { runBlocklistIdentityMutation } from "../infra/identityPolicy/coordination";

interface UnblockExecutionOutcome extends UnbanOutcome {
  removedFromList: boolean;
  persisted: boolean;
}

/** 同一身份较早的自动封禁结算后，再以本命令的较晚结果覆盖名单与群级封禁。 */
async function executeUnblock(targetUser: CachedUser, originChatId: number): Promise<UnblockExecutionOutcome> {
  // 先发布主线程 LRU 的解除结论，再投递 tombstone；后续入群更新立即读到新结论。
  const removedFromList: boolean = unblockUser(targetUser.id);
  // 名单里没有目标不代表各群没有封禁；默认完整解封仍要继续逐群执行。
  const persisted: boolean = removedFromList ? await confirmBlocklistPersisted() : true;
  const { unbannedCount, failedCount }: UnbanOutcome = await unbanEverywhereFor(targetUser, originChatId);
  return { removedFromList, persisted, unbannedCount, failedCount };
}

/**
 * `/block <目标> disable`：移除持久化黑名单身份，并解除已知管理群中的群级封禁。
 * 由 commands/block.ts 的 handleBlockCommand 按末位动作分派，只认 isCanUnBlock。
 *
 * 先移出名单并等待持久化结果，再执行各群解封；持久化失败仍继续解封，并在
 * 回执中附加警告。revision/ACK 与崩溃重放约束见 docs/cn/04-invariants.md。
 *
 * 目标支持回复、用户名、用户 id 或频道的负数 id；回复与参数同时存在时必须
 * 指向同一身份。裸 id 不要求命中缓存；`/block enable` 不接受裸负数 id。
 * @param targetArgument 去掉末位动作后的目标参数原文，可为空（此时只认回复目标）。
 */
export async function handleBlockDisable(ctx: CommandContext<Context>, targetArgument: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanUnBlock",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.unblockRejected(actorLabel)
  );
  if (actor === undefined) return;

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    acceptChatId: true,
    // unblockUser 按名单结论决定是否写 tombstone，冷读失败时不能当成「不在名单」。
    requireIdentityPolicies: true,
    // 拒绝当前群自己的身份，覆盖匿名管理员回复与裸会话 id；约束见 docs/cn/04-invariants.md。
    currentChatTargetText: chatAtmosphere(chatId).NOTICE_TEXTS.unblockCurrentChat,
    messages: chatAtmosphere(chatId).UNBLOCK_TARGET_TEXTS,
  });
  if (!targetUser) return;

  const {
    removedFromList,
    persisted,
    unbannedCount,
    failedCount,
  }: UnblockExecutionOutcome = await runBlocklistIdentityMutation(
    targetUser.id,
    (): Promise<UnblockExecutionOutcome> => executeUnblock(targetUser, chatId)
  );
  // 未收到持久化确认时附加警告；名单无变更时不等待 ACK。
  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
  const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
  const persistWarning: string = persisted
    ? ""
    : atmosphere.NOTICE_TEXTS.unblockPersistFailed;

  const listNote: string = removedFromList
    ? atmosphere.NOTICE_TEXTS.unblockRecorded(targetLabel, persistWarning)
    : atmosphere.NOTICE_TEXTS.unblockNotRecorded(targetLabel);

  if (unbannedCount === 0 && failedCount === 0) {
    await sendCommandMessage({
      chatId,
      replyToMessageId: messageId,
      text: atmosphere.NOTICE_TEXTS.unblockNoManagedChat(listNote),
    });
    return;
  }
  const failedNote: string = failedCount > 0 ? atmosphere.NOTICE_TEXTS.unblockPartialFailure(failedCount) : "";
  await sendCommandMessage({
    chatId,
    replyToMessageId: messageId,
    text: atmosphere.NOTICE_TEXTS.unblockResult(listNote, unbannedCount, failedNote),
  });
}

interface UnbanOutcome {
  unbannedCount: number;
  failedCount: number;
}

/**
 * 在机器人具有管理员身份的群中解除目标封禁。群清单与有界并发执行分别由
 * managedAdminChatIds、runManagedChatBatch 提供，结算结果按输入顺序计数。
 */
async function unbanEverywhereFor(targetUser: CachedUser, chatId: number): Promise<UnbanOutcome> {
  const isAdminHere: boolean = await resolveBotAdminStatus(chatId);
  const targetChatIds: number[] = managedAdminChatIds(chatId, isAdminHere);

  const outcomes: readonly ManagedChatOutcome<boolean>[] = await runManagedChatBatch<boolean>({
    chatIds: targetChatIds,
    action: `lift the ban on identity ${targetUser.id}`,
    onUnexpectedFailure: false,
    // 频道身份解除 sender_chat 封禁；用户仅解除已有封禁，保留在群成员身份。
    execute: (targetChatId: number): Promise<boolean> => targetUser.isChannel === true
      ? unbanChatSenderChat(targetChatId, targetUser.id)
      : unbanChatMemberIfBanned(targetChatId, targetUser.id),
  });

  let unbannedCount: number = 0;
  let failedCount: number = 0;
  for (const outcome of outcomes) {
    if (outcome.value) unbannedCount++;
    else failedCount++;
  }
  return { unbannedCount, failedCount };
}
