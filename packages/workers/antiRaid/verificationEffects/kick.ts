import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import {
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
} from "../../../consts/antiRaid/verification";
import { logger } from "../../../infra/logger";
import {
  joinVerificationApi,
  kickChatMemberWithOutcome,
  probeChatMembership,
} from "../../../infra/telegram";
import { verificationKey } from "../../../libs/verificationKey";
import type {
  VerificationDispatcher,
  VerificationEntry,
} from "../../../types/antiRaid/internal";
import type { VerificationState } from "../../../types/states/verification";
import type { KickChatMemberOutcome } from "../../../infra/telegram";
import { botCanRestrictIn } from "../botPermissions";
import { chatIsSupergroup } from "../chatKind";

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
  // **每一发都先付这次成员探测，首发也不例外。** 超级群的「只踢不封」映射到
  // unbanChatMember，它不带 only_if_banned 时会**解除已有封禁**（见
  // infra/telegram/actions/moderation.ts 的 kickChatMemberWithOutcome）。因此发这
  // 一枪之前必须确认目标此刻真的还是在群的普通成员：`getChatMember` 报
  // `kicked` 时 isPresentMember 为 false，人已经出去了，直接结算，绝不去碰那条
  // 封禁。
  //
  // 首发曾经豁免过这次探测，理由是「紧跟刚到达的那条 join update，那条 update
  // 自己就证明了人在群里」。它证明的是**在场**，不是**没有在排队期间被封**：
  // 锁群下的调用要排 joinVerificationApi 的每群限流队列，raid 期间那条队列前面
  // 积着大量洪水通知和其他移除（见 consts/antiRaid/flood.ts 与 floodControl.ts
  // 对队列深度的说明）；这段等待里人工管理员完全可能在客户端直接封禁这个人
  // （不走 /block，也就不进本 bot 的 FIFO）。排到的那一发于是解除了管理员的
  // 封禁，outcome 还报 "kicked"、kickSettled 上报成功，而那个人凭任意邀请链接
  // 就能回群。刷群路径上多付一次 getChatMember 换掉这个后果是划算的——正确性
  // 优先于调用量（见 AGENTS.md）。
  //
  // 查询失败（undefined）不等于不在群，也不足以授权这个调用，照常退避重试。
  const memberPresentBeforeKick: boolean | undefined =
    await probeChatMembership(chatId, userId, joinVerificationApi);
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
    isSupergroup: chatIsSupergroup(chatId),
    api: joinVerificationApi,
  });
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (outcome === "kicked") {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }

  // 请求失败后重新允许权威豁免替换 token，再用成员探测消除响应丢失的不确定性。
  transitionState.executionStarted = false;
  const memberPresent: boolean | undefined =
    await probeChatMembership(chatId, userId, joinVerificationApi);
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
