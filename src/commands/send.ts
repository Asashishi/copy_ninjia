import type { CommandContext, Context } from "grammy";
import { getActiveProxySendTarget, getOrCreateChatState, saveState } from "../infra/storage";
import { bot, logApiError, sendMessage } from "../infra/telegram";
import { isSuperAdmin } from "./superAdminToggle";

/**
 * /send <群组id> | /send finish —— 不注册进 setMyCommands 菜单（不想让这个
 * 指令在聊天框的命令提示里露面），仅 SUPER_ADMIN_USER_ID 本人可用，且只能
 * 在与机器人的私聊里触发：index.ts 最前端「私聊不触发任何命令」的网关对它
 * 单独放行（见 infra/updateGate.ts 的 shouldPassPrivateCommandGate），群里
 * 打出这个指令不会有任何反应，不暴露它的存在。私聊里被本人以外的账号探测
 * 到时同样保持沉默（见下方权限校验分支）——跟群里的「不确认它存在」是同一
 * 个原则，只是私聊场景更需要守住：这是唯一一个刻意允许在私聊触发的指令，
 * 不能被随便一句 "/send" 试出「这里有个只认身份的隐藏指令」。
 *
 * /send <群组id> 开启一轮中转：此后这个私聊里发的每条消息（任意类型，走
 * copyMessage 原样复制发到目标群一次，不带「转发自」标记，见
 * src/auto/message.ts 对 ChatState.isUseProxySend 的消费）都会被同步转发进
 * 该群，直到 /send finish 结束这轮中转。中转状态挂在目标群自己的
 * ChatState.isUseProxySend 上（不是这个私聊自己的状态，见该字段注释），
 * 随 state.json 持久化——机器人中途重启不会丢掉正在进行的中转。开启前会先
 * getChat 探一次目标是否可达（机器人是否在场/id 有没有打错），挡掉「确认
 * 成功、实际每条消息都转发失败」的场景；中转期间目标变得不可达（如机器人
 * 被踢出目标群）由 auto/message.ts 兜底检测并终止。
 */
export async function handleSendCommand(ctx: CommandContext<Context>): Promise<void> {
  // 群里打出这个指令不作任何回应——不确认它存在，也不用嘲讽文案暴露它。
  if (ctx.chat.type !== "private") return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  // 私聊里同样保持沉默：这是唯一允许私聊触发的指令，回一句嘲讽反而会向
  // 探测者确认「有这么个东西，而且认身份」——比群里的静默拒绝泄露得更多，
  // 见本文件头注。
  if (!isSuperAdmin(ctx.from)) return;

  const arg: string = ctx.match.trim();
  const activeTargetChatId: number | undefined = getActiveProxySendTarget();

  if (arg.toLowerCase() === "finish") {
    if (activeTargetChatId === undefined) {
      await sendMessage(chatId, `现在又没在转发，是想 finish 什么呀♡`, messageId);
      return;
    }
    getOrCreateChatState(activeTargetChatId).isUseProxySend = false;
    await saveState();
    await sendMessage(chatId, `好啦，不转发了♡`, messageId);
    return;
  }

  const targetChatId: number = Number(arg);
  if (!arg || !Number.isSafeInteger(targetChatId)) {
    await sendMessage(chatId, `笨蛋，要 /send <群组id> 或者 /send finish，说清楚呀♡`, messageId);
    return;
  }

  if (activeTargetChatId !== undefined) {
    await sendMessage(chatId, `已经在转发到 ${activeTargetChatId} 了，先 /send finish 呀♡`, messageId);
    return;
  }

  // 开转前先确认这个目标够得着——不然打错 id、或者本天才压根没在那边，
  // 这里照样能"成功"开启会话，之后每条消息在 copyMessage 那步才悄悄失败
  // （见 auto/message.ts），超管却已经收到了成功提示，会一直被蒙在鼓里。
  try {
    const targetChat = await bot.api.getChat(targetChatId);
    if (targetChat.type !== "group" && targetChat.type !== "supergroup") {
      await sendMessage(chatId, `只能转发进群组呀，${targetChatId} 不是群组，检查一下 id♡`, messageId);
      return;
    }
  } catch (error: unknown) {
    logApiError(`resolve /send target chat ${targetChatId}`, error);
    await sendMessage(chatId, `连不上 ${targetChatId} 这个聊天呀，检查一下 id 对不对、本天才是不是已经在那边了♡`, messageId);
    return;
  }

  getOrCreateChatState(targetChatId).isUseProxySend = true;
  await saveState();
  await sendMessage(chatId, `好，现在这里发的消息本天才都会转发进 ${targetChatId}，说完了记得 /send finish♡`, messageId);
}
