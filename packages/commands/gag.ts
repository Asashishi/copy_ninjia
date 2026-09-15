import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";

import type { CommandContext, Context } from "grammy";
import { gagSessionCount } from "../cache/main/gag";
import { GAG_SESSION_MAX } from "../consts/gag";

import type { CachedUser } from "../types/chatState";
import type {
  GagSession,
  ParsedGagCommand,
} from "../types/gag";
import type { BotChatPermissions } from "../types/telegram";
import {
  botChatPermissionsIn,
} from "../infra/botAdmin";
import { getChatState } from "../infra/storage/stateStore";
import {
  probeChatMembership,
  sendCommandMessage,
  sendMessage,
} from "../infra/telegram";
import { explicitReplyTo, forumTopicThreadId } from "../libs/forumTopic";
import { sanitizeDisplayName } from "../libs/text";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";
import {
  canRenderMaximumInlineQuery,
  parseGagCommand,
  renderGagPublicNotice,
} from "./gag/rendering";
import { createGagTargetProfileUrl } from "./gag/identity";
import { sendGagSpeakNotice } from "./gag/notices";
import { findGagSession } from "./gag/owner";
import {
  commitGagNotices,
  failGagNotice,
  finishGag,
  recordGagPublicNotice,
  recordGagSpeakNotice,
  requestGagCleanupRetry,
  reserveGagSession,
} from "./gag/runtime";
import type { GagReservationOutcome } from "./gag/runtime";
import { resolveCommandTarget } from "./targetResolution";

/** `/gag`、`/ungag` 共用的身份、群状态与机器人删除权限门禁。 */
async function passesGagCommandGate(
  ctx: CommandContext<Context>,
  command: "gag" | "ungag"
): Promise<boolean> {
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const actorLabel: string = actor === undefined
    ? chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.unknownActor
    : formatUserLabel(actor, chatAtmosphere(ctx.chat?.id ?? 0));
  if (!hasCommandPermission(ctx, "isCanGag")) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagRejected(actorLabel, command),
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  if (
    ctx.chat.type !== "group" &&
    ctx.chat.type !== "supergroup"
  ) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagGroupOnly,
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  if (getChatState(ctx.chat.id).isInitEnabled !== true) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagNotInitialized,
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  const permissions: BotChatPermissions | undefined =
    await botChatPermissionsIn(ctx.chat.id);
  if (permissions?.canDeleteMessages !== true) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagMissingRights,
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  return true;
}

/** 构造一次容量预约；字段固定顺序与类型避免 active 时再改变对象 shape。 */
function createGagReservation(
  ctx: CommandContext<Context>,
  target: CachedUser,
  parsed: ParsedGagCommand
): GagSession {
  return {
    chatId: ctx.chat.id,
    targetId: target.id,
    targetProfileUrl: createGagTargetProfileUrl(target),
    targetLabel: formatTargetLabel(target, chatAtmosphere(ctx.chat?.id ?? 0)),
    chatLabel: sanitizeDisplayName(ctx.chat.title ?? String(ctx.chat.id)),
    tool: parsed.tool,
    durationMinutes: parsed.durationMinutes,
    phase: "starting",
    expiresAt: 0,
    publicNoticeMessageId: 0,
    speakNoticeMessageId: 0,
    pendingSpeakNoticeMessageId: 0,
    retiredSpeakNoticeMessageId: 0,
    // 入口从下命令的那个话题起步；随后被管教的人换话题说话时再搬家
    // （见 commands/gag/refresh.ts 的 refreshGagSpeakNoticeOnSpeech）。
    speakNoticeThreadId: forumTopicThreadId(ctx.msg),
    messagesSinceSpeakNotice: 0,
    lastTargetMessageAt: 0,
    speakNoticeRefreshTask: null,
    speakNoticeRefreshTimer: null,
    noticePending: true,
    timer: null,
    cleanupRetryIndex: 0,
    cleanupTimer: null,
    endingTask: null,
  };
}

/** 处理 `/gag`：预约容量、按目标身份发开始提示，成功后才开始删目标消息。 */
export async function handleGagCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!await passesGagCommandGate(ctx, "gag")) return;
  const parsed: ParsedGagCommand | undefined = parseGagCommand(
    ctx.match,
    explicitReplyTo(ctx.msg) !== undefined
  );
  if (parsed === undefined) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat?.id ?? 0).GAG_USAGE_TEXT,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  if (!canRenderMaximumInlineQuery(parsed.tool)) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagToolTooLong,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  if (gagSessionCount() >= GAG_SESSION_MAX) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagCapacity(GAG_SESSION_MAX),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId: ctx.chat.id,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: parsed.rawTarget,
    acceptUserId: true,
    acceptChatId: true,
    messages: chatAtmosphere(ctx.chat?.id ?? 0).GAG_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const existingTarget: GagSession | undefined = findGagSession(
    ctx.chat.id,
    target.id
  );
  if (existingTarget !== undefined) {
    const atmosphere: AtmosphereTexts = chatAtmosphere(ctx.chat?.id ?? 0);
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: existingTarget.phase === "ending"
        ? atmosphere.NOTICE_TEXTS.gagEnding(formatTargetLabel(target, atmosphere))
        : atmosphere.NOTICE_TEXTS.gagExists(formatTargetLabel(target, atmosphere)),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  const targetMembership: boolean | undefined = target.isChannel === true
    ? true
    : await probeChatMembership(ctx.chat.id, target.id);
  if (targetMembership !== true) {
    const atmosphere: AtmosphereTexts = chatAtmosphere(ctx.chat?.id ?? 0);
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: targetMembership === false
        ? atmosphere.NOTICE_TEXTS.gagTargetAbsent(formatTargetLabel(target, atmosphere))
        : atmosphere.NOTICE_TEXTS.gagMembershipUnknown(formatTargetLabel(target, atmosphere)),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  // 目标解析与成员查询后必须再同步预约，才能在任何调用入口下严格守住全局
  // 容量。starting 不拦消息，发送失败只撤销本对象。
  const session: GagSession = createGagReservation(ctx, target, parsed);
  const reservation: GagReservationOutcome = reserveGagSession(session);
  if (reservation === "quiescing") return;
  if (reservation !== "reserved") {
    const existing: GagSession | undefined = findGagSession(
      session.chatId,
      session.targetId
    );
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: reservation === "full"
        ? chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagCapacity(GAG_SESSION_MAX)
        : existing?.phase === "ending"
          ? chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagEnding(session.targetLabel)
          : chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.gagExists(session.targetLabel),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  // 普通用户先在群里留一条无按钮状态，再发 receiver_user_id 限定的入口；
  // 频道没有接收用户，公开状态本身就是其发言入口。两个身份分开登记，结束某个
  // 会话时只能删除该会话的精确入口，不能把相同数字的临时 id 当成群消息 id。
  //
  // onSent 是这条路径的**结算保险**：停机 abort 可能落在「远端已收下提示、这里
  // 还没走到 commitGagNotices」的窗口里，await 会以 AbortError 解开并带走
  // message id。先同步登记，abort 之后这条会话仍是「已发出、可删除」的完整状态，
  // 由停机排空按正常 ending 路径删掉。
  const recordPublicNotice = (sentMessageId: number): void => {
    recordGagPublicNotice(session, sentMessageId);
  };
  const recordSpeakNotice = (sentMessageId: number): void => {
    recordGagSpeakNotice(session, sentMessageId);
  };
  try {
    if (target.isChannel === true) {
      const speakNoticeMessageId: number | undefined =
        await sendGagSpeakNotice({
          session,
          messageThreadId: session.speakNoticeThreadId,
          replyToMessageId: ctx.msgId,
          onSent: recordSpeakNotice,
        });
      if (speakNoticeMessageId === undefined) {
        await failGagNotice(session);
        return;
      }
      recordGagSpeakNotice(session, speakNoticeMessageId);
      await commitGagNotices(session);
      return;
    }
    const publicNoticeMessageId: number | undefined = await sendMessage({
      chatId: session.chatId,
      text: renderGagPublicNotice(session),
      replyToMessageId: ctx.msgId,
      // 公开状态是「这个人被管教了」的一次性播报，留在下命令的话题即可，不搬家；
      // 发言提示由状态机而非固定延迟清理持有，属长期留存，因此挂了回复也照样
      // 带话题；判定口径见 SendMessageParams.messageThreadId。
      messageThreadId: session.speakNoticeThreadId,
      onSent: recordPublicNotice,
    });
    if (publicNoticeMessageId === undefined) {
      await failGagNotice(session);
      return;
    }
    recordGagPublicNotice(session, publicNoticeMessageId);
    if (
      findGagSession(session.chatId, session.targetId) !== session ||
      session.phase !== "starting"
    ) {
      await commitGagNotices(session);
      return;
    }
    const speakNoticeMessageId: number | undefined =
      await sendGagSpeakNotice({
        session,
        messageThreadId: session.speakNoticeThreadId,
        onSent: recordSpeakNotice,
      });
    if (speakNoticeMessageId === undefined) {
      await failGagNotice(session);
      return;
    }
    recordGagSpeakNotice(session, speakNoticeMessageId);
    await commitGagNotices(session);
  } catch (error: unknown) {
    // 判据是整段发送流程是否仍未提交，不是「最后一次 onSent 有没有被调用」。
    // failGagNotice 会删除所有已同步登记的提示；删除失败才保留 ending owner 重试，
    // 绝不能把已发出的公开或临时消息连同 id 一起丢掉。
    if (session.noticePending) await failGagNotice(session);
    throw error;
  }
}

/** 处理 `/ungag`：必须用回复、@username 或用户/频道 id 定位本群的唯一目标。 */
export async function handleUngagCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!await passesGagCommandGate(ctx, "ungag")) return;
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId: ctx.chat.id,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: ctx.match,
    acceptUserId: true,
    acceptChatId: true,
    messages: chatAtmosphere(ctx.chat?.id ?? 0).UNGAG_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const session: GagSession | undefined = findGagSession(ctx.chat.id, target.id);
  if (session?.phase !== "active") {
    if (session?.phase === "ending") {
      requestGagCleanupRetry(session);
    }
    const atmosphere: AtmosphereTexts = chatAtmosphere(ctx.chat?.id ?? 0);
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: session?.phase === "ending"
        ? atmosphere.NOTICE_TEXTS.ungagEnding(formatTargetLabel(target, atmosphere))
        : session?.phase === "starting"
          ? atmosphere.NOTICE_TEXTS.ungagStarting(formatTargetLabel(target, atmosphere))
          : atmosphere.NOTICE_TEXTS.ungagAbsent(formatTargetLabel(target, atmosphere)),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  await finishGag(session, "ungag", ctx.msgId);
}

export {
  handleGagInlineQuery,
  handleGagMessageIngress,
} from "./gag/inline";
export {
  drainGagRuntime,
  initGagRuntime,
  quiesceGagRuntime,
  resetGagSessions,
  teardownGagInChat,
} from "./gag/runtime";
