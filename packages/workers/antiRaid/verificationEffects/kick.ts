import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import {
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
} from "../../../consts/antiRaid/verification";
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

interface ScheduleKickRetryParams {
  chatId: number;
  userId: number;
  state: VerificationState & { kind: "kickPending" };
  dispatchVerification: VerificationDispatcher;
}

/** 为仍是当前 token 的私密模式踢人动作安排指数退避重试。 */
function scheduleKickRetry({
  chatId,
  userId,
  state,
  dispatchVerification,
}: ScheduleKickRetryParams): void {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (entry?.state !== state) return;
  state.effectStarted = false;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  const retries: number = entry.terminalRetries ?? 0;
  entry.terminalRetries = retries + 1;
  entry.timer = setTimeout(
    (): void => dispatchVerification(chatId, userId, { type: "kickRetry" }),
    Math.min(
      VERIFICATION_TERMINAL_RETRY_MS * (2 ** retries),
      VERIFICATION_TERMINAL_RETRY_MAX_MS
    )
  );
}

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
  // 与可恢复 expelling 共用同一权限语义：确证没有限制成员权限时，本轮只推进
  // 本地退避，不发送成员探测或踢人请求；未知仍让 Telegram 作最终裁判。
  //
  // 请求短路了，诊断不能跟着短路：这条分支下没有任何 Telegram 调用去触发下面
  // 那行 logger.error，管理员因此看不到「私密模式想踢却踢不动」的任何线索，
  // 而记录会一路静默退避到 VERIFICATION_TERMINAL_RETRY_MAX_MS。每轮一行，与
  // 正常路径（每次重试失败各记一行）同一密度，且这里一个请求都不发。
  if (botCanRestrictIn(chatId) === false) {
    transitionState.executionStarted = false;
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
  // **每一发都先付这次成员探测，首发也不例外。** 超级群的「只踢不封」映射到
  // unbanChatMember，它不带 only_if_banned 时会**解除已有封禁**（见
  // infra/telegram/actions/moderation.ts 的 kickChatMemberWithOutcome）。因此发这
  // 一枪之前必须确认目标此刻真的还是在群的普通成员：`getChatMember` 报
  // `kicked` 时 isPresentMember 为 false，人已经出去了，直接结算，绝不去碰那条
  // 封禁。
  //
  // join update 只能证明到达时在场，不能证明请求排队期间没有被人工管理员封禁。
  // Telegram 429 会让调用进入 kick 类别的独立退避车道，因此首发与重试都必须
  // 重新确认成员状态，避免不带 only_if_banned 的 unbanChatMember 解除现有封禁。
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
