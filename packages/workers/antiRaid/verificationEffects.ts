import { logger } from "../../infra/logger";
import {
  answerCallbackQuery,
  deleteMessage,
  deleteMessageAfter,
  joinVerificationApi,
  kickChatMember,
  probeChatMembership,
  sendMessage,
} from "../../infra/telegram";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../../consts/telegram";
import {
  VERIFICATION_TERMINAL_RETRY_MAX_MS,
  VERIFICATION_TERMINAL_RETRY_MS,
  VERIFICATION_TIMEOUT_MS,
  WELCOME_AUTO_DELETE_MS,
} from "../../consts/antiRaid/verification";
import { verificationEntries } from "../../cache/antiRaid/verification";
import { formatMinSec } from "../../libs/time";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationDispatcher } from "../../types/antiRaid/internal";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationState,
  VerificationTerminalState,
} from "../../types/states/verification";
import { fetchAdminIds, freshAdminIds } from "./adminCache";
import { retractJoin } from "./lockdownRuntime";
import {
  sendReplyReminder,
  sendVerificationReminder,
} from "./verificationReminders";
import { trackAntiRaidTask } from "./taskTracker";
import type { VerificationEntry } from "../../cache/antiRaid/verification";

type VerificationChangePublisher = (
  chatId: number,
  userId: number,
  previousWasPersisted: boolean
) => void;

export interface RunVerificationEffectsParams {
  chatId: number;
  userId: number;
  effects: VerificationEffect[];
  dispatchVerification: VerificationDispatcher;
  publishVerificationChange: VerificationChangePublisher;
}

/** 按序执行一次转移返回的副作用；同一列表内先删后踢再通知的顺序有意义。 */
export async function runVerificationEffects({
  chatId,
  userId,
  effects,
  dispatchVerification,
  publishVerificationChange,
}: RunVerificationEffectsParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const transitionState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  for (const effect of effects) {
    switch (effect.kind) {
      case "deleteMessage":
        await deleteMessage(chatId, effect.messageId, joinVerificationApi);
        break;
      case "kickMember": {
        // 状态对象就是这批不可逆动作的执行 token。删除公告等前置 await 期间，
        // 豁免、停管或新一代记录都会替换/删除它；调用 Telegram 前的同步复核
        // 保证旧批次不会继续踢人。
        if (
          transitionState?.kind !== "kickPending" ||
          verificationEntries.get(key)?.state !== transitionState
        ) break;
        transitionState.executionStarted = true;
        await kickChatMember(chatId, userId, joinVerificationApi);
        if (verificationEntries.get(key)?.state === transitionState) {
          dispatchVerification(chatId, userId, {
            type: "kickSettled",
            now: Date.now(),
          });
        }
        break;
      }
      case "deleteReminders":
        if (effect.reminderMessageId !== undefined) {
          await deleteMessage(chatId, effect.reminderMessageId, joinVerificationApi);
        }
        if (effect.replyReminderMessageId !== undefined) {
          await deleteMessage(chatId, effect.replyReminderMessageId, joinVerificationApi);
        }
        break;
      case "expel":
      case "expelFlood": {
        const expectedState: VerificationState | undefined =
          verificationEntries.get(verificationKey(chatId, userId))?.state;
        const reason: "timeout" | "flood" =
          effect.kind === "expelFlood" ? "flood" : "timeout";
        if (
          expectedState?.kind !== "expelling" ||
          expectedState.reason !== reason ||
          expectedState.snapshot !== effect.snapshot
        ) break;
        const settled: boolean = await expelMember({
          chatId,
          userId,
          snapshot: effect.snapshot,
          reason,
          expectedState,
          publishVerificationChange,
        });
        if (
          settled &&
          verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState
        ) {
          dispatchVerification(chatId, userId, { type: "expelSettled" });
        } else if (
          verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState &&
          expectedState.successNoticeSent !== true
        ) {
          // 只有踢人失败等可重试处置才走本地 timer。成功播报已经发送时必须
          // 原地等待对应 revision 的真实落盘回执。
          expectedState.executionStarted = false;
          const entry: VerificationEntry | undefined = verificationEntries.get(verificationKey(chatId, userId));
          if (entry !== undefined) {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            // 指数退避（同 verificationReminders.ts 的做法），不是固定 30 秒一轮：
            // 有些失败注定不会好转——机器人是管理员却没有封禁权限，或目标本人就是
            // 这个群的管理员。记录按设计不能删（删了就等于把没处置的成员当成已
            // 完成，见 states/verification.ts 的 left 分支），因此能收敛的只有节奏。
            // 固定间隔时，一次刷群留下的每个未验证成员都会永久占住一个 30 秒循环，
            // 各自不停打 deleteMessage + kickChatMember 并往 logs/ 刷同一行报错。
            // 退避有上限：管理员补上权限后最迟一个上限周期内自愈，不必重启进程。
            const retries: number = entry.terminalRetries ?? 0;
            entry.terminalRetries = retries + 1;
            entry.timer = setTimeout(
              (): void => dispatchVerification(chatId, userId, { type: "terminalPersisted" }),
              Math.min(VERIFICATION_TERMINAL_RETRY_MS * (2 ** retries), VERIFICATION_TERMINAL_RETRY_MAX_MS)
            );
          }
        }
        break;
      }
      case "recheckInviter": {
        const expectedState: VerificationState | undefined =
          verificationEntries.get(verificationKey(chatId, userId))?.state;
        if (
          expectedState?.kind !== "checkingInviter" ||
          expectedState.snapshot !== effect.snapshot
        ) break;
        await recheckInviterThenSettle({
          chatId,
          userId,
          inviterId: effect.inviterId,
          expectedState,
          dispatchVerification,
        });
        break;
      }
      case "sendReminder":
        sendVerificationReminder({
          chatId,
          userId,
          label: effect.label,
          isBot: effect.isBot,
          dispatchVerification,
        });
        break;
      case "sendReplyReminder":
        sendReplyReminder({
          chatId,
          userId,
          label: effect.label,
          targetMessageId: effect.targetMessageId,
          dispatchVerification,
        });
        break;
      case "sendWelcome": {
        const welcomeText: string =
          effect.variant === "channelComment"
            ? `哼，${effect.targetLabel} 老实巴交的在帖子底下冒个了泡，本天才大发慈悲免了你的验证，欢迎杂鱼入群~♡`
            : effect.variant === "vouchedBot"
              ? `哼，既然 ${effect.fromLabel} 大人愿意为机器人 ${effect.targetLabel} 作保，本天才就勉为其难放这个铁疙瘩进来啦~♡`
              : `哼，算你机灵，${effect.fromLabel} 通过验证啦，欢迎杂鱼入群~♡`;
        const welcomeMessageId: number | undefined = await sendMessage({
          chatId,
          text: welcomeText,
          replyToMessageId: effect.anchorMessageId,
          api: joinVerificationApi,
        });
        if (welcomeMessageId !== undefined) {
          deleteMessageAfter({
            chatId,
            messageId: welcomeMessageId,
            delayMs: WELCOME_AUTO_DELETE_MS,
            api: joinVerificationApi,
          });
        }
        break;
      }
      case "answerCallback": {
        const replyText: string | undefined =
          effect.reply === "ok"
            ? "验证通过啦～"
            : effect.reply === "invalid"
              ? "验证已经失效啦，再试试重新进群吧"
              : effect.reply === "notYourBotButton"
                ? "帮机器人作保是白名单大人的特权，杂鱼别乱点～"
                : "这不是你的验证按钮哦，杂鱼别乱点～";
        await answerCallbackQuery({
          callbackQueryId: effect.callbackQueryId,
          text: replyText,
          showAlert: effect.reply !== "ok",
          api: joinVerificationApi,
        });
        break;
      }
      case "startAdminCheck":
        startAdminCheck({
          chatId,
          userId,
          actorId: effect.actorId,
          dispatchVerification,
        });
        break;
      case "retractJoinCount":
        retractJoin(chatId, effect.joinedAt);
        break;
      case "logUncancelableKickExemption":
        // 必须是 error：Worker 只向主线程中继 error 级别的日志信封，warn 只会
        // 留在本线程的临时 stdout 里（见 infra/logger.ts 与 libs/supervisedWorker.ts）。
        // 而这条正是「一个合法成员被误踢了、请人工拉回来」的唯一线索，事后翻
        // logs/ 看不到它，那个人就一直在群外。
        logger.error(
          `The kick request for member ${effect.label} (chat ${chatId}, user ${userId}) had already been sent or completed ` +
          `when exemption proof (admin/whitelist identity) arrived; it cannot be undone automatically — ` +
          "an admin may need to manually re-invite them if this was a false positive."
        );
        break;
    }
  }
}

interface StartAdminCheckParams {
  chatId: number;
  userId: number;
  actorId: number;
  dispatchVerification: VerificationDispatcher;
}

/** 异步核查拉人者管理员身份；只向仍是同一对象的 pending 状态回投结果。 */
function startAdminCheck({
  chatId,
  userId,
  actorId,
  dispatchVerification,
}: StartAdminCheckParams): void {
  const key: string = verificationKey(chatId, userId);
  const captured: VerificationState | undefined = verificationEntries.get(key)?.state;
  if (captured?.kind !== "pending") return;
  void trackAntiRaidTask({
    task: fetchAdminIds(chatId)
      .then((adminIds: Set<number>): void => {
        if (!adminIds.has(actorId)) return;
        if (verificationEntries.get(key)?.state === captured) {
          dispatchVerification(chatId, userId, { type: "adminCheckResolved" });
        }
      })
      .catch((error: unknown): void => {
        logger.error(
          `Error fetching chat admins for admin-invite exemption in chat ${chatId}:`,
          error
        );
      }),
  });
}

interface RecheckInviterThenSettleParams {
  chatId: number;
  userId: number;
  inviterId: number;
  expectedState: VerificationTerminalState & { kind: "checkingInviter" };
  dispatchVerification: VerificationDispatcher;
}

/** 超时踢人前最终核对拉人者身份，避免管理员缓存过期造成误踢。 */
async function recheckInviterThenSettle({
  chatId,
  userId,
  inviterId,
  expectedState,
  dispatchVerification,
}: RecheckInviterThenSettleParams): Promise<void> {
  const cachedAdmins: Set<number> | undefined = freshAdminIds(chatId);
  let inviterIsAdmin: boolean = cachedAdmins?.has(inviterId) === true;
  if (cachedAdmins === undefined) {
    try {
      inviterIsAdmin = (await fetchAdminIds(chatId)).has(inviterId);
    } catch (error: unknown) {
      logger.error(
        `Error rechecking admin-invite exemption before expiring verification in chat ${chatId}:`,
        error
      );
    }
  }
  if (verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState) {
    dispatchVerification(chatId, userId, {
      type: "timeoutInviterVerdict",
      inviterIsAdmin,
    });
  }
}

interface ExpelMemberParams {
  chatId: number;
  userId: number;
  snapshot: ExpelSnapshot;
  reason: "timeout" | "flood";
  expectedState: VerificationTerminalState & { kind: "expelling" };
  publishVerificationChange: VerificationChangePublisher;
}

type ExpelRemovalOutcome = "kicked" | "absent" | "unconfirmed" | "failed" | "stale";

/**
 * challenge 终态可能晚于入群更新几十秒甚至跨过落盘重放；踢人前必须重新确认
 * 目标此刻仍在群里。查询失败不等于“不在群”，但也没有得到执行破坏性成员操作
 * 所需的确认，因此本轮不踢、保留终态给既有退避重试。成员查询本身又引入一个
 * await 边界，返回后必须复核终态仍是同一对象；否则 teardown 或新状态已接管时，
 * 迟到结果会把合法成员踢掉。
 */
async function kickPresentMember(
  chatId: number,
  userId: number,
  isCurrent: () => boolean
): Promise<ExpelRemovalOutcome> {
  const present: boolean | undefined =
    await probeChatMembership(chatId, userId, joinVerificationApi);
  if (present === false) return "absent";
  if (present === undefined) return "unconfirmed";
  // 检查与 API 调用之间没有 await，确保一旦确认仍是当前终态就立刻发起处置。
  if (!isCurrent()) return "stale";
  return await kickChatMember(chatId, userId, joinVerificationApi) ? "kicked" : "failed";
}

/** 清理超时/刷屏成员的消息并按现查结果踢出，成功播报先写入新 revision 再收尾。 */
async function expelMember({
  chatId,
  userId,
  snapshot,
  reason,
  expectedState,
  publishVerificationChange,
}: ExpelMemberParams): Promise<boolean> {
  const stillCurrent = (): boolean =>
    verificationEntries.get(verificationKey(chatId, userId))?.state === expectedState;
  let removalOutcome: ExpelRemovalOutcome = "failed";
  if (!stillCurrent()) return false;
  if (reason === "flood") {
    removalOutcome = await kickPresentMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  // 入群公告排在最前：它是这条记录里最早的一条痕迹，也是唯一一条机器人自己
  // 制造、除本路径外没人会去删的消息（见 PendingState.announcementMessageId）。
  // 同下面每条一样先复核记录仍是当前的：flood 那一路的踢人 await 之后状态可能
  // 已被替换，而被豁免成员的入群公告是**不该**删的（见 states/verification.ts）。
  if (snapshot.announcementMessageId !== undefined) {
    if (!stillCurrent()) return false;
    await deleteMessage(chatId, snapshot.announcementMessageId, joinVerificationApi);
  }
  for (const messageId of snapshot.messageIds) {
    if (!stillCurrent()) return false;
    await deleteMessage(chatId, messageId, joinVerificationApi);
  }
  if (!stillCurrent()) return false;
  if (reason === "timeout") {
    removalOutcome = await kickPresentMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  // Telegram 已确认人不在群：处置目标已经满足，不发“踢出成功”或“权限失败”
  // 的错误战报，直接让状态机删除这条终态记录。
  if (removalOutcome === "absent") return stillCurrent();
  const kicked: boolean = removalOutcome === "kicked";
  const noticeText: string = !kicked
    ? removalOutcome === "unconfirmed"
      ? `啧，本天才没能确认 ${snapshot.label} 现在还在不在群里，所以这次没有贸然踢人；会继续重试，杂鱼管理员也检查下网络和本天才的成员查询权限！`
      : reason === "flood"
        ? `啧，${snapshot.label} 没完成验证还在刷屏，本天才想把 TA 踢出去却没踢动……管理员快检查本天才的封禁权限！`
        : `啧，${snapshot.label} 超时没验证，本天才本想把 TA 踢出去，结果居然没踢动……肯定是哪个杂鱼管理员没给本天才封禁权限！快去检查，不然只能你们自己动手请 TA 出去咯♡`
    : reason === "flood"
      ? `啧，${snapshot.label} 验证都没过就开始刷屏，本天才已经先把 TA 踢出去、再把痕迹清干净啦♡`
      : snapshot.isBot
        ? `啧，${formatMinSec(VERIFICATION_TIMEOUT_MS)} 过去了都没有白名单大人愿意为机器人 ${snapshot.label} 作保，本天才把这个来路不明的铁疙瘩连痕迹一起清出去啦♡`
        : `啧，${snapshot.label} 磨磨蹭蹭 ${formatMinSec(VERIFICATION_TIMEOUT_MS)} 都点不出验证按钮，本天才把 TA 的痕迹清干净、顺手踢出去啦，杂鱼动作太慢咯♡`;
  if (!stillCurrent()) return false;
  // 三条文案各记各的名额：探测抖动发出的「没能确认还在不在群里」不能把
  // 「踢不动，去检查封禁权限」那条唯一指出真实原因的诊断顶掉（见
  // ExpellingState.failureNoticeSent）。
  const shouldSendNotice: boolean = kicked
    ? expectedState.successNoticeSent !== true
    : removalOutcome === "unconfirmed"
      ? expectedState.unconfirmedNoticeSent !== true
      : expectedState.failureNoticeSent !== true;
  const noticeMessageId: number | undefined = shouldSendNotice
    ? await sendMessage({
      chatId,
      text: noticeText,
      api: joinVerificationApi,
    })
    : undefined;
  // 只有真的发出去了才置位。sendMessage 失败返回 undefined（错误被
  // infra/telegram/actions.ts 吞掉）；踢人失败 + 公告也失败时若照样置位，
  // 终态重试再跑 expelMember 时 shouldSendNotice 已是 false，「本天才没有封禁
  // 权限」这条唯一的诊断就永远不再尝试——未验证成员留在群里，管理员什么都
  // 不知道。本来就已发过（shouldSendNotice === false）时保持不变。
  if (!kicked && (!shouldSendNotice || noticeMessageId !== undefined)) {
    if (removalOutcome === "unconfirmed") expectedState.unconfirmedNoticeSent = true;
    else expectedState.failureNoticeSent = true;
    // 失败诊断不自删，必须跟着快照落盘：不持久化的话每次 Worker 重生都会
    // 重发一条，同一个卡住的成员在群里越堆越多（见 ExpellingState）。
    publishVerificationChange(chatId, userId, true);
  }
  if (noticeMessageId !== undefined && kicked) {
    deleteMessageAfter({
      chatId,
      messageId: noticeMessageId,
      delayMs: KICK_NOTICE_AUTO_DELETE_MS,
      api: joinVerificationApi,
    });
    expectedState.successNoticeSent = true;
    publishVerificationChange(chatId, userId, true);
    return false;
  }
  return kicked && stillCurrent();
}
