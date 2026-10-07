import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import { logger } from "../../../infra/logger";
import {
  kickChatMemberWithOutcome,
  probeChatMembership,
  telegramApi,
} from "../../../infra/telegram";
import { verificationKey } from "../../../libs/verificationKey";
import type {
  VerificationDispatcher,
  VerificationEntry,
} from "../../../types/antiRaid/internal";
import type { VerificationState } from "../../../types/states/verification";
import type { KickChatMemberOutcome } from "../../../infra/telegram";
import { botCanRestrictIn } from "../botPermissions";
import { resolveChatIsSupergroup } from "../chatKind";
import { scheduleKickRetry } from "./retry";

interface RunKickMemberEffectParams {
  chatId: number;
  userId: number;
  transitionState: VerificationState | undefined;
  dispatchVerification: VerificationDispatcher;
}

/**
 * 执行私密模式踢人。transitionState 是整批 effect 捕获的执行 token，任何豁免、
 * 停管或新一代记录都会让不可逆调用在同步复核处失效。
 */
export async function runKickMemberEffect({
  chatId,
  userId,
  transitionState,
  dispatchVerification,
}: RunKickMemberEffectParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (
    transitionState?.kind !== "kickPending" ||
    entry?.state !== transitionState
  ) return;
  // 与可恢复 expelling 共用同一权限语义：确证没有限制成员权限时，本轮只发成员探测、
  // 不发踢人请求——成员已离群即结算，否则推进本地退避；未知仍让 Telegram 作最终裁判。
  // 请求短路时诊断照常：每轮记一行日志，与正常路径每次重试失败各记一行同一密度。
  if (botCanRestrictIn(chatId) === false) {
    transitionState.executionStarted = false;
    const presentWithoutPermission: boolean | undefined =
      await probeChatMembership(chatId, userId, telegramApi);
    if (verificationEntries.get(key)?.state !== transitionState) return;
    if (presentWithoutPermission === false) {
      dispatchVerification(chatId, userId, {
        type: "kickSettled",
        now: Date.now(),
      });
      return;
    }
    logger.error(
      `Lockdown kick for user ${userId} in chat ${chatId} was not attempted: the bot is confirmed to lack ` +
      "can_restrict_members there; retaining the pending action and backing off until the permission returns."
    );
    scheduleKickRetry({
      chatId,
      userId,
      state: transitionState,
      dispatchVerification,
    });
    return;
  }
  const isSupergroup: boolean | undefined =
    await resolveChatIsSupergroup(chatId);
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (isSupergroup === undefined) {
    transitionState.executionStarted = false;
    logger.error(
      `Lockdown kick for user ${userId} in chat ${chatId} could not resolve whether the chat is a group or supergroup; ` +
      "retaining the pending action rather than guessing a removal API."
    );
    scheduleKickRetry({
      chatId,
      userId,
      state: transitionState,
      dispatchVerification,
    });
    return;
  }
  // **首发与重试都先做成员探测。** 超级群的「只踢不封」映射到 unbanChatMember，
  // 不带 only_if_banned 时会**解除已有封禁**（见 infra/telegram/actions/moderation.ts
  // 的 kickChatMemberWithOutcome），因此发请求前必须确认目标此刻仍是在群的普通成员：
  // `getChatMember` 报 `kicked` 时探测结果为 false，直接结算，不碰封禁。
  //
  // 查询失败（undefined）不等于不在群，也不足以授权这个调用，照常退避重试。
  const memberPresentBeforeKick: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (memberPresentBeforeKick === false) {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }
  if (memberPresentBeforeKick === undefined) {
    logger.error(
      `Lockdown kick for user ${userId} in chat ${chatId} could not confirm the member is still present; ` +
      "retaining the pending action rather than issuing a removal that would lift a ban placed in the meantime."
    );
    scheduleKickRetry({
      chatId,
      userId,
      state: transitionState,
      dispatchVerification,
    });
    return;
  }

  transitionState.executionStarted = true;
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId,
    userId,
    isSupergroup,
    api: telegramApi,
  });
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (outcome === "kicked" || outcome === "absent") {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }

  // 请求失败后重新允许权威豁免替换 token，再用成员探测消除响应丢失的不确定性。
  transitionState.executionStarted = false;
  const memberPresent: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (memberPresent === false) {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }
  logger.error(
    outcome === "forbidden"
      ? `Lockdown kick for user ${userId} in chat ${chatId} was forbidden by Telegram permissions or member status; retaining the pending action for retry.`
      : `Lockdown kick for user ${userId} in chat ${chatId} did not settle; retaining the pending action for retry.`
  );
  scheduleKickRetry({
    chatId,
    userId,
    state: transitionState,
    dispatchVerification,
  });
}
