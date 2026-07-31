import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { MuteChatMemberOutcome, UnmuteChatMemberOutcome } from "../infra/telegram";
import { muteChatMemberWithOutcome, sendCommandMessage, unmuteChatMemberWithOutcome } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../infra/config";
import { isWhitelisted } from "../config/whitelist";
import {
  MUTE_DURATION_ARG_PATTERN,
  MUTE_DURATION_UNIT_MS,
  MUTE_MAX_DURATION_MS,
  MUTE_MIN_DURATION_MS,
} from "../consts/commands";
import { resolveCommandTarget } from "./targetResolution";
import type { CommandTargetMessages } from "./targetResolution";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";

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
  const match: RegExpExecArray | null = MUTE_DURATION_ARG_PATTERN.exec(token);
  if (match === null) return undefined;
  const value: number = Number(match[1]!);
  const unit: "m" | "h" | "d" = match[2]!.toLowerCase() as "m" | "h" | "d";
  const durationMs: number = value * MUTE_DURATION_UNIT_MS[unit];
  return Math.min(MUTE_MAX_DURATION_MS, Math.max(MUTE_MIN_DURATION_MS, durationMs));
}

/**
 * 把毫秒时长念成中文。只服务本命令的战报：输入一定是整分钟，且经过
 * parseMuteDurationMs 的收敛后天然是「整天 / 整小时 / 整分钟」三档取最大
 * 整除单位——用户写 90m 就念 90 分钟，不替他换算成一个半小时。
 * 导出仅为可测试性。
 */
export function formatMuteDuration(durationMs: number): string {
  if (durationMs % MUTE_DURATION_UNIT_MS.d === 0) return `${durationMs / MUTE_DURATION_UNIT_MS.d} 天`;
  if (durationMs % MUTE_DURATION_UNIT_MS.h === 0) return `${durationMs / MUTE_DURATION_UNIT_MS.h} 小时`;
  return `${Math.round(durationMs / MUTE_DURATION_UNIT_MS.m)} 分钟`;
}

/** `/mute` 的用法提示，参数缺失/不合法时统一回这一句。 */
const MUTE_USAGE_TEXT: string =
  `笨蛋，/mute 后面要带时长：数字加 m/h/d，比如 10m、2h、1d（1 分钟~366 天）；` +
  `回复 TA 的消息发 /mute 10m，或者 /mute @username 10m、/mute 用户id 10m♡`;

/**
 * /mute 与 /unmute 共用的入口校验：发起人在白名单里、且本群是超级群。
 * 任一不满足时回复嘲讽/说明并返回 false，调用方直接 return。
 * `restrictChatMember` 按 Bot API 的定义只对超级群有效，普通群与私聊里连
 * 目标都不必解析——打出去只会换一句报错（同 antiRaid/floodControl.ts 只在
 * 超级群计数的理由）。
 */
async function passesMuteCommandGate(ctx: CommandContext<Context>, command: "mute" | "unmute"): Promise<boolean> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const permission: "isCanMute" | "isCanUnMute" =
    command === "mute" ? "isCanMute" : "isCanUnMute";

  if (!actor || !hasCommandPermission(ctx, permission, false)) {
    await sendCommandMessage({
      chatId,
      text: `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想 /${command} 人？哪来的资格呀，笨蛋，洗洗睡吧♡`,
      replyToMessageId: messageId,
    });
    return false;
  }

  if (ctx.chat.type !== "supergroup") {
    await sendCommandMessage({
      chatId,
      text: `笨蛋，Telegram 只让在超级群里捂人嘴巴，这里本天才有力也使不出呀♡`,
      replyToMessageId: messageId,
    });
    return false;
  }

  return true;
}

/** /mute 与 /unmute 的目标解析文案，除动词外与 /block 的口径一致。 */
function muteTargetMessages(command: "mute" | "unmute"): CommandTargetMessages {
  return {
    missingTarget: `笨蛋，要么 /${command} @username 或 /${command} 用户id，要么回复 TA 的一条消息，本天才可不会读心术♡`,
    invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数），别拿半截参数糊弄本天才♡`,
    unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息再来吧♡`,
    conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想对谁动手就只留一个，要么删掉参数、要么别回复♡`,
    selfTarget: `笨蛋，本天才才不会捂自己的嘴呢♡`,
  };
}

/**
 * 目标是不是「按不下去」的身份：频道马甲/匿名管理员没有可禁言的成员身份
 * （restrictChatMember 只认真实用户，皮套底下是谁 Telegram 不暴露——同
 * antiRaid/floodControl.ts 不计数的理由）。命中时回复说明并返回 true。
 */
async function rejectUnrestrictableTarget(
  ctx: CommandContext<Context>,
  targetUser: CachedUser
): Promise<boolean> {
  if (targetUser.isChannel !== true) return false;
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: `${formatTargetLabel(targetUser)} 是频道皮套，皮套没有嘴可捂，Telegram 也不告诉本天才底下是谁呀♡`,
    replyToMessageId: ctx.msgId,
  });
  return true;
}

/**
 * 处理 /mute 指令：临时收走目标在本群的全部发言权限，到点由 Telegram 按
 * `until_date` 自动恢复——与刷屏禁言（workers/antiRaid/floodControl.ts）复用
 * 同一个 API 封装与权限集，本进程不排恢复计时器、不写任何持久化状态，提前
 * 解除走 /unmute。
 *
 * 参数形态：时长必填且必须是最后一个 token（`数字+m/h/d`，见
 * parseMuteDurationMs），目标用回复消息、@username 或用户 id 指定（时长带
 * 单位字母、id 是纯数字，两者形态互斥，不会互相抢参数）。仅
 * 白名单内对应 isCanMute=true 的身份可用；目标是自己人（超级管理员或白名单
 * 成员）时拒绝——他们本来就不参与任何自动处置（见 antiRaid/memberFacts.ts
 * 的 isProtectedSender），手动命令也不该例外。
 *
 * 战报不自动删除：/block 那类公告删的是「处置已完结」的战报，这条公告在
 * 禁言期内就是「TA 为什么不说话」的唯一现场说明；时长又长达 366 天，远超
 * setTimeout 的取值范围，定时删除本身都不可靠。
 */
export async function handleMuteCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  if (!await passesMuteCommandGate(ctx, "mute")) return;

  // 时长永远取最后一个 token：前面剩下的整段是目标参数（可以为空，此时目标
  // 来自回复）。先验时长再解析目标——时长格式错误时目标是谁根本无关紧要，
  // 一句用法提示比「@x 不合法」更接近用户真正打错的地方。
  const tokens: string[] = ctx.match.trim().split(/\s+/).filter((token: string): boolean => token.length > 0);
  const durationToken: string | undefined = tokens.at(-1);
  const durationMs: number | undefined = durationToken === undefined ? undefined : parseMuteDurationMs(durationToken);
  if (durationMs === undefined) {
    await sendCommandMessage({ chatId, text: MUTE_USAGE_TEXT, replyToMessageId: messageId });
    return;
  }

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: tokens.slice(0, -1).join(" "),
    // 禁言可逆，但目标照样用 id 指定最准（同 /block 的理由：用户名会被释放后
    // 重新注册）；时长 token 带单位字母，纯数字的 id 不会被它接住。
    acceptUserId: true,
    messages: muteTargetMessages("mute"),
  });
  if (!targetUser) return;
  if (await rejectUnrestrictableTarget(ctx, targetUser)) return;

  // 自己人不可禁言：部署方亲手配的身份不该被机器人按住（口径同
  // isProtectedSender），回错消息也只损失一句嘲讽。
  if (targetUser.id === SUPER_ADMIN_USER_ID || isWhitelisted(targetUser.id)) {
    await sendCommandMessage({
      chatId,
      text: `笨蛋，${formatTargetLabel(targetUser)} 可是自己人，本天才才不捂自己人的嘴♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const targetLabel: string = formatTargetLabel(targetUser);
  const outcome: MuteChatMemberOutcome = await muteChatMemberWithOutcome({
    chatId,
    userId: targetUser.id,
    mutedUntil: Date.now() + durationMs,
  });
  if (outcome === "muted") {
    await sendCommandMessage({
      chatId,
      text: `哼，${targetLabel} 被本天才捂住嘴 ${formatMuteDuration(durationMs)}，到点自动松开；等不及就找管理员 /unmute 吧♡`,
      replyToMessageId: messageId,
    });
    return;
  }
  // forbidden 混着两种成因（机器人缺「限制成员」权限，或目标本身是管理员），
  // Telegram 回的是同一句 400，文案把两种都说给管理员听；failed 是限流/网络
  // 抖动，值得再试。具体原因已由统一错误边界记进日志。
  const failureText: string = outcome === "forbidden"
    ? `呜……${targetLabel} 捂不住：要么本天才没有「限制成员」的权限，要么 TA 是管理员，杂鱼管理员自己去看看吧♡`
    : `呜……Telegram 这会儿不理本天才，${targetLabel} 没捂住，稍后再试一次吧♡`;
  await sendCommandMessage({ chatId, text: failureText, replyToMessageId: messageId });
}

/**
 * 处理 /unmute 指令：立刻恢复目标在本群的发言权限（全权限置真，实际能力仍
 * 与群默认权限取交集，见 consts/telegram.ts 的 UNMUTED_CHAT_PERMISSIONS）。
 * 不带时长参数；目标指定方式与权限门槛同 /mute。目标本来就没被禁言时
 * Telegram 一样返回成功，不必事先区分——恢复方向指错目标至多是一次空操作
 * （同 /unblock 对恢复方向的宽容）。也不设自己人闸：解除限制只会把人放出来，
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
    messages: muteTargetMessages("unmute"),
  });
  if (!targetUser) return;
  if (await rejectUnrestrictableTarget(ctx, targetUser)) return;

  const targetLabel: string = formatTargetLabel(targetUser);
  const outcome: UnmuteChatMemberOutcome = await unmuteChatMemberWithOutcome({
    chatId,
    userId: targetUser.id,
  });
  if (outcome === "unmuted") {
    await sendCommandMessage({
      chatId,
      text: `哼，本天才大发慈悲把 ${targetLabel} 的嘴松开了，下次注意点哦杂鱼♡`,
      replyToMessageId: messageId,
    });
    return;
  }
  const failureText: string = outcome === "forbidden"
    ? `呜……${targetLabel} 松不开：要么本天才没有「限制成员」的权限，要么 TA 是管理员（管理员本来也没被捂着呀），杂鱼管理员自己去看看吧♡`
    : `呜……Telegram 这会儿不理本天才，${targetLabel} 还没松开，稍后再试一次吧♡`;
  await sendCommandMessage({ chatId, text: failureText, replyToMessageId: messageId });
}
