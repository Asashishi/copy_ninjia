import type { AtmosphereTexts } from "../types/atmosphere";
import type { AtmosphereNotices } from "../types/atmosphereNotices";
import { chatAtmosphere } from "../infra/atmosphere";

import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { MuteChatMemberOutcome, UnmuteChatMemberOutcome } from "../infra/telegram";
import { muteChatMemberWithOutcome, sendCommandMessage, unmuteChatMemberWithOutcome } from "../infra/telegram";
import { formatTargetLabel } from "../users/userLabel";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { botChatPermissionsIn } from "../infra/botAdmin";
import type { BotChatPermissions } from "../types/telegram";
import { MUTE_DISPATCH_MIN_REMAINING_MS, MUTE_MAX_DURATION_MS, MUTE_MIN_DURATION_MS } from "../consts/commands";

import { describeBotPermissionGap } from "../libs/botPermissionGap";
import {
  formatDurationCn,
  parseDurationTokenMs,
} from "../libs/durationToken";
import { commandArgumentTokens } from "./arguments";
import { resolveCommandTarget } from "./targetResolution";
import { rejectUnlessPermitted } from "./commandActor";

/**
 * 把 `/mute` 的时长 token 解析成毫秒数并收敛进合法区间。
 *
 * 形态不合法（缺单位、带小数、非正数等）返回 undefined，交给调用方回用法
 * 提示；合法但越界的值收敛到边界而不是拒绝（与 /quiet 同一风格），实际生效
 * 的时长由战报念出来，收没收敛用户看得见。上下限的来源见 consts/commands.ts
 * 的 MUTE_MIN_DURATION_MS / MUTE_MAX_DURATION_MS（Bot API 把出界的
 * `until_date` 当成永久禁言，而本进程不排恢复计时器）。数值大到超出安全整数
 * 时乘法结果只会更大，同样落进最大值收敛，不需要单独拒绝。
 * 导出仅为可测试性。
 */
export function parseMuteDurationMs(token: string): number | undefined {
  const durationMs: number | undefined = parseDurationTokenMs(token);
  if (durationMs === undefined) return undefined;
  return Math.min(MUTE_MAX_DURATION_MS, Math.max(MUTE_MIN_DURATION_MS, durationMs));
}

/**
 * `forbidden` 结局的回执。Telegram 对「机器人缺限制成员权限」与「目标本身是管理员」
 * 回的是同一句 400，因此按机器人自己的权限快照分辨：确证不是管理员或缺
 * 「限制与封禁成员」时点名原因；快照缺失或该位齐全时把两种成因都说给管理员听。
 * 具体错误已由统一错误边界记进日志。
 */
async function forbiddenReplyText(
  chatId: number,
  targetLabel: string,
  command: "mute" | "unmute"
): Promise<string> {
  const notices: Readonly<AtmosphereNotices> = chatAtmosphere(chatId).NOTICE_TEXTS;
  const permissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  const reason: string | undefined = permissions === undefined
    ? undefined
    : describeBotPermissionGap(permissions, "canRestrictMembers", notices);
  if (command === "mute") {
    return reason === undefined
      ? notices.muteForbidden(targetLabel)
      : notices.muteBotLacksRights(targetLabel, reason);
  }
  return reason === undefined
    ? notices.unmuteForbidden(targetLabel)
    : notices.unmuteBotLacksRights(targetLabel, reason);
}

/**
 * /mute 与 /unmute 共用的入口校验：发起人持有对应权限、且本群是超级群。
 * 任一不满足时回复嘲讽/说明并返回 false，调用方直接 return。
 * `restrictChatMember` 按 Bot API 的定义只对超级群有效，普通群与私聊里连
 * 目标都不必解析——打出去只会换一句报错（同 antiRaid/floodControl.ts 只在
 * 超级群计数的口径）。
 */
async function passesMuteCommandGate(ctx: CommandContext<Context>, command: "mute" | "unmute"): Promise<boolean> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const permission: "isCanMute" | "isCanUnMute" =
    command === "mute" ? "isCanMute" : "isCanUnMute";
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    permission,
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.muteRejected(actorLabel, command)
  );
  if (actor === undefined) return false;

  if (ctx.chat.type !== "supergroup") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).NOTICE_TEXTS.muteSupergroupOnly,
      replyToMessageId: messageId,
    });
    return false;
  }

  return true;
}

/**
 * 目标是不是「按不下去」的身份：频道马甲/匿名管理员没有可禁言的成员身份
 * （restrictChatMember 只认真实用户，皮套底下是谁 Telegram 不暴露——同
 * antiRaid/floodControl.ts 不计数的口径）。命中时回复说明并返回 true。
 */
async function rejectUnrestrictableTarget(
  ctx: CommandContext<Context>,
  targetUser: CachedUser
): Promise<boolean> {
  if (targetUser.isChannel !== true) return false;
  const atmosphere: AtmosphereTexts = chatAtmosphere(ctx.chat.id);
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: atmosphere.NOTICE_TEXTS.muteChannelTarget(formatTargetLabel(targetUser, atmosphere)),
    replyToMessageId: ctx.msgId,
  });
  return true;
}

/**
 * 处理 /mute 指令：临时收走目标在本群的全部发言权限，到点由 Telegram 按
 * `until_date` 自动恢复——与刷屏禁言（workers/antiRaid/floodControl.ts）复用
 * 同一个 API 封装与权限集，本进程不排恢复计时器、不写任何持久化状态，提前
 * 解除走 /unmute。**派发截止也共用同一条契约**：`until_date` 是入队前算好的
 * 绝对时刻，排队太久会被 Bot API 当成永久限制，因此两条路径都必须给
 * `muteChatMemberWithOutcome` 传 `dispatchTimeoutMs`，各自的预算见
 * MUTE_DISPATCH_MIN_REMAINING_MS 与 FLOOD_MUTE_DISPATCH_TIMEOUT_MS。
 *
 * 参数形态：时长必填且必须是最后一个 token（`数字+m/h/d`，见
 * parseMuteDurationMs），目标用回复消息、@username 或用户 id 指定（时长带
 * 单位字母、id 是纯数字，两者形态互斥，不会互相抢参数）。仅持有 isCanMute 的
 * 身份可用（超级管理员恒持有，见 whitelist.ts）；目标是自己人（isWhitelisted
 * 边界内的身份，含超级管理员）时拒绝——自动处置按同一边界排除他们（见
 * antiRaid/adDetect.ts），手动命令也不例外。
 *
 * 成功战报与失败提示一样走 sendCommandMessage 的默认路径，30 秒后自动删除：
 * 群里的非功能性提示统一由那道边界回收，操作回执也在其内（见
 * docs/cn/04-invariants.md）。长期保留是需要显式授权的例外，`/mute`
 * 不在其中——`preserveInGroup: true` 只出现在获授权的调用点（`/permission help`
 * 与 `/permission query` 的权限看板，以及成功的中文动作命令）。禁言期内
 * 「TA 为什么不说话」由 Telegram 自己的成员
 * 权限界面回答，不靠一条常驻群里的机器人消息。
 */
export async function handleMuteCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  if (!await passesMuteCommandGate(ctx, "mute")) return;

  // 时长永远取最后一个 token：前面剩下的整段是目标参数（可以为空，此时目标
  // 来自回复）。先验时长再解析目标——时长格式错误时目标是谁根本无关紧要，
  // 一句用法提示比「@x 不合法」更接近用户真正打错的地方。
  const tokens: string[] = commandArgumentTokens(ctx.match);
  const durationToken: string | undefined = tokens.at(-1);
  const durationMs: number | undefined = durationToken === undefined ? undefined : parseMuteDurationMs(durationToken);
  if (durationMs === undefined) {
    await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).MUTE_USAGE_TEXT, replyToMessageId: messageId });
    return;
  }

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: tokens.slice(0, -1).join(" "),
    // 禁言可逆，但目标照样用 id 指定最准（同 /block：用户名会被释放后
    // 重新注册）；时长 token 带单位字母，纯数字的 id 不会被它接住。
    acceptUserId: true,
    // 下面的自己人闸读 isWhitelisted，冷读失败时不能当成「不受保护」。
    requireIdentityPolicies: true,
    messages: chatAtmosphere(chatId).MUTE_TARGET_TEXTS,
  });
  if (!targetUser) return;
  if (await rejectUnrestrictableTarget(ctx, targetUser)) return;

  // 自己人不可禁言：部署方亲手配的身份不该被机器人按住（口径同自动处置的
  // isWhitelisted 边界，超级管理员已含在内），回错消息也只损失一句嘲讽。
  if (isWhitelisted(targetUser.id)) {
    const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
    await sendCommandMessage({
      chatId,
      text: atmosphere.NOTICE_TEXTS.muteProtected(formatTargetLabel(targetUser, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }

  const targetLabel: string = formatTargetLabel(targetUser, chatAtmosphere(chatId));
  const outcome: MuteChatMemberOutcome = await muteChatMemberWithOutcome({
    chatId,
    userId: targetUser.id,
    mutedUntil: Date.now() + durationMs,
    // 与刷屏禁言同一条契约：`until_date` 是入队前算好的绝对时刻，请求命中
    // restrict 类 429 后还会在独立车道按 retry_after 排队。排太久时 Bot API 会
    // 把它当成永久限制，而本命令不排恢复计时器——那就是一次只能人工 /unmute 的
    // 永久禁言，而下面的成功文案还写着「到点自动松开」。到期即放弃，走 failed
    // 那一句如实回执（见 consts/commands.ts 的 MUTE_DISPATCH_MIN_REMAINING_MS）。
    dispatchTimeoutMs: durationMs - MUTE_DISPATCH_MIN_REMAINING_MS,
  });
  if (outcome === "muted") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).NOTICE_TEXTS.muteDone(targetLabel, formatDurationCn(durationMs)),
      replyToMessageId: messageId,
    });
    return;
  }
  // failed 是限流/网络抖动，值得再试；forbidden 的措辞见 forbiddenReplyText。
  const failureText: string = outcome === "forbidden"
    ? await forbiddenReplyText(chatId, targetLabel, "mute")
    : chatAtmosphere(chatId).NOTICE_TEXTS.muteFailed(targetLabel);
  await sendCommandMessage({ chatId, text: failureText, replyToMessageId: messageId });
}

/**
 * 处理 /unmute 指令：立刻恢复目标在本群的发言权限（全权限置真，实际能力仍
 * 与群默认权限取交集，见 consts/telegram.ts 的 UNMUTED_CHAT_PERMISSIONS）。
 * 不带时长参数；目标指定方式与权限门槛同 /mute。目标本来就没被禁言时
 * Telegram 一样返回成功，不必事先区分——恢复方向指错目标至多是一次空操作
 * （同 /block disable 对恢复方向的宽容）。也不设自己人闸：解除限制只会把人放出来，
 * 自己人被别的管理员禁了言，正该能用这条命令捞。
 */
export async function handleUnmuteCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  if (!await passesMuteCommandGate(ctx, "unmute")) return;

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: ctx.match,
    acceptUserId: true,
    messages: chatAtmosphere(chatId).UNMUTE_TARGET_TEXTS,
  });
  if (!targetUser) return;
  if (await rejectUnrestrictableTarget(ctx, targetUser)) return;

  const targetLabel: string = formatTargetLabel(targetUser, chatAtmosphere(chatId));
  const outcome: UnmuteChatMemberOutcome = await unmuteChatMemberWithOutcome({
    chatId,
    userId: targetUser.id,
  });
  if (outcome === "unmuted") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).NOTICE_TEXTS.unmuteDone(targetLabel),
      replyToMessageId: messageId,
    });
    return;
  }
  const failureText: string = outcome === "forbidden"
    ? await forbiddenReplyText(chatId, targetLabel, "unmute")
    : chatAtmosphere(chatId).NOTICE_TEXTS.unmuteFailed(targetLabel);
  await sendCommandMessage({ chatId, text: failureText, replyToMessageId: messageId });
}
