import type { CommandContext, Context } from "grammy";
import { gagSessionCount } from "../cache/main/gag";
import {
  GAG_SESSION_MAX,
  GAG_TARGET_TEXTS,
  UNGAG_TARGET_TEXTS,
} from "../consts/gag";
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
  sendEphemeralMessage,
  sendMessage,
} from "../infra/telegram";
import { sanitizeDisplayName } from "../libs/text";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";
import {
  canRenderMaximumInlineQuery,
  buildGagSpeakKeyboard,
  parseGagCommand,
} from "./gag/rendering";
import {
  commitGagNotices,
  failGagNotice,
  findGagSession,
  finishGag,
  recordGagEphemeralNotice,
  recordGagPublicNotice,
  requestGagCleanupRetry,
  reserveGagSession,
} from "./gag/runtime";
import type { GagReservationOutcome } from "./gag/runtime";
import { resolveCommandTarget } from "./targetResolution";

/** `/gag` 的固定用法提示；目标可由回复消息提供。 */
const GAG_USAGE_TEXT: string =
  "哈？连怎么给杂鱼戴东西都不会吗♡ 用法是 /gag <@username|用户/频道id> [5|10|15] [用具]；" +
  "回复目标消息时只写 /gag [5|10|15] [用具] 就行，" +
  "没写时长就罚 5 分钟，没写用具就赏个口塞，记住了吗，笨蛋♡";

/** `/gag`、`/ungag` 共用的身份、群状态与机器人删除权限门禁。 */
async function passesGagCommandGate(
  ctx: CommandContext<Context>,
  command: "gag" | "ungag"
): Promise<boolean> {
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const actorLabel: string = actor === undefined
    ? "哪个杂鱼"
    : formatUserLabel(actor);
  if (!hasCommandPermission(ctx, "isCanGag")) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: `哈？就 ${actorLabel} 这种没资格的杂鱼也想 /${command} 人？做梦去吧♡`,
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
      text: "噗，连地方都找不对吗？/gag 和 /ungag 只能在群里用啦，笨蛋♡",
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  if (getChatState(ctx.chat.id).isInitEnabled !== true) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: "这个群连 /init enable 都没开，还想使唤本天才管 gag？先把准备做好呀，杂鱼♡",
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  const permissions: BotChatPermissions | undefined =
    await botChatPermissionsIn(ctx.chat.id);
  if (permissions?.canDeleteMessages !== true) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: "本天才不在群里当管理员、也没有「删除消息」权限的话，可擦不了杂鱼的发言哦？快去补好啦♡",
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
    targetLabel: formatTargetLabel(target),
    chatLabel: sanitizeDisplayName(ctx.chat.title ?? String(ctx.chat.id)),
    tool: parsed.tool,
    durationMinutes: parsed.durationMinutes,
    phase: "starting",
    expiresAt: 0,
    publicNoticeMessageId: 0,
    ephemeralNoticeMessageId: 0,
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
    ctx.msg.reply_to_message !== undefined
  );
  if (parsed === undefined) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: GAG_USAGE_TEXT,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  if (!canRenderMaximumInlineQuery(parsed.tool)) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: "噗，这个用具名字长到连 Telegram 的 inline 消息都塞不下，杂鱼的命名品味也太差了吧♡",
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  if (gagSessionCount() >= GAG_SESSION_MAX) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: `本天才同时管教的 ${GAG_SESSION_MAX} 只杂鱼已经满员啦，连排队都不会吗？等一个结束再来♡`,
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
    messages: GAG_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const existingTarget: GagSession | undefined = findGagSession(
    ctx.chat.id,
    target.id
  );
  if (existingTarget !== undefined) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: existingTarget.phase === "ending"
        ? `${formatTargetLabel(target)} 这只杂鱼还在收尾，急什么呀？乖乖等着♡`
        : `${formatTargetLabel(target)} 这只杂鱼在本群已经被管教啦；要换工具就先定向 /ungag，笨蛋♡`,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  const targetMembership: boolean | undefined = target.isChannel === true
    ? true
    : await probeChatMembership(ctx.chat.id, target.id);
  if (targetMembership !== true) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: targetMembership === false
        ? `${formatTargetLabel(target)} 根本不在这个群里，想隔空 gag 人的杂鱼在做什么梦呀♡`
        : `本天才暂时确认不了 ${formatTargetLabel(target)} 还在不在群里，急也没用，等会儿再试啦♡`,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  // 跨群 update 不共用 sequentialize 车道；目标解析与成员查询后必须再同步
  // 预约，才能严格守住全局容量。starting 不拦消息，发送失败只撤销本对象。
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
        ? `本天才同时管教的 ${GAG_SESSION_MAX} 只杂鱼已经满员啦，连排队都不会吗？等一个结束再来♡`
        : existing?.phase === "ending"
          ? `${session.targetLabel} 这只杂鱼还在收尾，急什么呀？乖乖等着♡`
          : `${session.targetLabel} 这只杂鱼在本群已经被管教啦；要换工具就先定向 /ungag，笨蛋♡`,
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  const publicNoticeText: string =
    `哼哼，${session.targetLabel} 这只爱乱说话的杂鱼已经戴上 ${session.tool} 啦♡ ` +
    `${session.durationMinutes} 分钟内普通消息都会被本天才删掉。` +
    (target.isChannel === true
      ? "频道马甲想说话就必须先乖乖点下面的「发言」按钮，直接 @ 本天才可不会给你选项哦，连入口都找不到的杂鱼就安静待着吧♡"
      : "");
  const ephemeralNoticeText: string =
    `${session.targetLabel}，只有你看得到这个发言入口；` +
    "想说话就乖乖点下面的「发言」按钮啦♡";
  // 所有目标先在群里留一条公开状态；普通用户的公开消息不带按钮，再单独发送
  // receiver_user_id 限定的入口。频道没有接收用户，按钮只能留在公开提示上。
  //
  // onSent 是这条路径的**结算保险**：停机 abort 可能落在「远端已收下提示、这里
  // 还没走到 commitGagNotices」的窗口里，await 会以 AbortError 解开并带走
  // message id。先同步登记，abort 之后这条会话仍是「已发出、可删除」的完整状态，
  // 由停机排空按正常 ending 路径删掉。
  const recordPublicNotice = (sentMessageId: number): void => {
    recordGagPublicNotice(session, sentMessageId);
  };
  const recordEphemeralNotice = (sentMessageId: number): void => {
    recordGagEphemeralNotice(session, sentMessageId);
  };
  try {
    const publicNoticeMessageId: number | undefined = await sendMessage({
      chatId: session.chatId,
      text: publicNoticeText,
      replyToMessageId: ctx.msgId,
      ...(target.isChannel === true
        ? { keyboard: buildGagSpeakKeyboard(target.id) }
        : {}),
      onSent: recordPublicNotice,
    });
    if (publicNoticeMessageId === undefined) {
      await failGagNotice(session);
      return;
    }
    recordGagPublicNotice(session, publicNoticeMessageId);
    if (target.isChannel === true) {
      await commitGagNotices(session);
      return;
    }
    if (
      findGagSession(session.chatId, session.targetId) !== session ||
      session.phase !== "starting"
    ) {
      await commitGagNotices(session);
      return;
    }
    const ephemeralNoticeMessageId: number | undefined =
      await sendEphemeralMessage({
        chatId: session.chatId,
        receiverUserId: target.id,
        text: ephemeralNoticeText,
        keyboard: buildGagSpeakKeyboard(target.id),
        onSent: recordEphemeralNotice,
      });
    if (ephemeralNoticeMessageId === undefined) {
      await failGagNotice(session);
      return;
    }
    recordGagEphemeralNotice(session, ephemeralNoticeMessageId);
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
    messages: UNGAG_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const session: GagSession | undefined = findGagSession(ctx.chat.id, target.id);
  if (session?.phase !== "active") {
    if (session?.phase === "ending") {
      requestGagCleanupRetry(session);
    }
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: session?.phase === "ending"
        ? `${formatTargetLabel(target)} 的 gag 已经在收尾啦，急什么呀杂鱼？乖乖等着♡`
        : session?.phase === "starting"
          ? `${formatTargetLabel(target)} 还没戴好呢，手忙脚乱的杂鱼先等一下♡`
          : `${formatTargetLabel(target)} 在本群根本没被本天才 gag，对着空气 /ungag 的笨蛋♡`,
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
