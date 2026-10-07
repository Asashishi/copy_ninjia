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
import {
  probeChatMembership,
  sendCommandMessage,
  sendMessage,
} from "../infra/telegram";
import { describeBotPermissionGap } from "../libs/botPermissionGap";
import { explicitReplyTo, forumTopicThreadId } from "../libs/forumTopic";
import { sanitizeDisplayName } from "../libs/text";
import { formatTargetLabel } from "../users/userLabel";
import { rejectUnlessPermitted } from "./commandActor";
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

/** `/gag`、`/ungag` 共用的身份、群类型与机器人删除权限门禁。 */
async function passesGagCommandGate(
  ctx: CommandContext<Context>,
  command: "gag" | "ungag"
): Promise<boolean> {
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanGag",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.gagRejected(actorLabel, command)
  );
  if (actor === undefined) return false;
  if (
    ctx.chat.type !== "group" &&
    ctx.chat.type !== "supergroup"
  ) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere().NOTICE_TEXTS.gagGroupOnly,
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  const permissions: BotChatPermissions | undefined =
    await botChatPermissionsIn(ctx.chat.id);
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const permissionGap: string | undefined = describeBotPermissionGap(
    permissions,
    "canDeleteMessages",
    atmosphere.NOTICE_TEXTS
  );
  if (permissionGap !== undefined) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: atmosphere.NOTICE_TEXTS.gagMissingRights(command, permissionGap),
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  return true;
}

/** 构造一次容量预约；字段一次初始化，进入 active 后不再增删字段。 */
function createGagReservation(
  ctx: CommandContext<Context>,
  target: CachedUser,
  parsed: ParsedGagCommand
): GagSession {
  return {
    chatId: ctx.chat.id,
    targetId: target.id,
    targetProfileUrl: createGagTargetProfileUrl(target),
    targetLabel: formatTargetLabel(target, chatAtmosphere()),
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
      text: chatAtmosphere().GAG_USAGE_TEXT,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  if (!canRenderMaximumInlineQuery(parsed.tool)) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere().NOTICE_TEXTS.gagToolTooLong,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  if (gagSessionCount() >= GAG_SESSION_MAX) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: chatAtmosphere().NOTICE_TEXTS.gagCapacity(GAG_SESSION_MAX),
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
    messages: chatAtmosphere().GAG_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const existingTarget: GagSession | undefined = findGagSession(
    ctx.chat.id,
    target.id
  );
  if (existingTarget !== undefined) {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
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
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: targetMembership === false
        ? atmosphere.NOTICE_TEXTS.gagTargetAbsent(formatTargetLabel(target, atmosphere))
        : atmosphere.NOTICE_TEXTS.gagMembershipUnknown(formatTargetLabel(target, atmosphere)),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  // 目标解析与成员查询之后同步预约，守住全局容量；starting 阶段不拦消息，
  // 发送失败只撤销本会话。
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
        ? chatAtmosphere().NOTICE_TEXTS.gagCapacity(GAG_SESSION_MAX)
        : existing?.phase === "ending"
          ? chatAtmosphere().NOTICE_TEXTS.gagEnding(session.targetLabel)
          : chatAtmosphere().NOTICE_TEXTS.gagExists(session.targetLabel),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  // 普通用户先在群里留一条无按钮的公开状态，再发 receiver_user_id 限定的发言入口；
  // 频道没有接收用户，只发一条发言入口提示。两个 message id 分开登记，结束会话时
  // 按各自的精确 id 删除。
  //
  // onSent 在发送返回前同步登记 message id：停机 abort 落在发送完成与
  // commitGagNotices 之间时，会话仍是「已发出、可删除」的状态，由停机排空按 ending
  // 路径删除。
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
      // 公开状态留在下命令的话题，不随发言搬家；它由状态机而非固定延迟清理持有，
      // 属长期留存，显式带话题（见 SendMessageParams.messageThreadId）。
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
    // 判据是整段发送流程是否仍未提交（session.noticePending）。failGagNotice 删除
    // 所有已同步登记的提示；删除失败时保留 ending owner 重试，已登记的 id 不丢弃。
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
    messages: chatAtmosphere().UNGAG_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const session: GagSession | undefined = findGagSession(ctx.chat.id, target.id);
  if (session?.phase !== "active") {
    if (session?.phase === "ending") {
      requestGagCleanupRetry(session);
    }
    const atmosphere: AtmosphereTexts = chatAtmosphere();
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
