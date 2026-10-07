import { Composer, GrammyError, matchFilter } from "grammy";
import type {
  Bot,
  BotError,
  Context,
  Filter,
  MiddlewareFn,
  NextFunction,
} from "grammy";
import { handleIncomingMessageMiddleware, handleReaction } from "../auto";
import {
  confirmLuckDraw,
  handleAdDetectCommand,
  handleAiChatCommand,
  handleBatchKickCommand,
  handleBlockCommand,
  handleHImageCommand,
  handleInfoCommand,
  handleBotStatusCommand,
  handleCjkActionCommand,
  handleCjkActionUsageCommand,
  handleClearContextCommand,
  handleCopyCommand,
  handleAntiRaidCommand,
  handleFloodControlCommand,
  handleGagCommand,
  handleGagMessageIngress,
  handleQaBoardCallback,
  handleQaMessageIngress,
  handleQaCommand,
  handleInitCommand,
  handleTranslateCommand,
  handleInlineQuery,
  handleLuckChosenInlineResult,
  handleMuteCommand,
  handlePermissionCommand,
  handleMoodCommand,
  handleQuietCommand,
  handleSendCommand,
  handleIconCommand,
  dispatchWedCommand,
  dispatchWedCallback,
  handleUngagCommand,
  handleUnmuteCommand,
  handleUnquietCommand,
  handleWhiteCommand,
} from "../commands";
import {
  handleChatMemberUpdate,
  handleAntiRaidMessageIngress,
  handleVerificationCallback,
} from "../antiRaid";
import { handleMyChatMemberUpdate } from "../infra/botAdmin";
import { observeWedMemberDeparture, observeWedMembers } from "../commands/wed/members";
import { CJK_ACTION_COMMAND_PATTERN, SLASH_CHAR_CODE } from "../consts/commands";
import { logger } from "../infra/logger";
import { shouldPassBotMessage } from "../infra/botMessageGate";
import {
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
} from "../infra/identityStorage";
import {
  shouldPassInitGate,
  shouldPassPrivateCommandGate,
  shouldRoutePrivateProxyMessage,
} from "../infra/updateGate";
import { messageOriginIdentityId } from "../users/messageOrigin";
import type { Chat, Message } from "grammy/types";
import type { HandlerRegistration } from "../types/lifecycle";

/** 仅把冷身份加入预热批次；全热 update 不分配临时数组。 */
function appendColdIdentityId(
  current: number[] | null,
  id: number
): number[] | null {
  if (isIdentityPolicyCached(id)) return current;
  if (current === null) return [id];
  current.push(id);
  return current;
}

/**
 * 把「认领即终止、否则放行」的 ingress（Anti-Raid、gag、`/qa set` 表单投递）收敛成同一条
 * MaybePromise 边界：入参为 boolean 时同步决定是否 next，为 Promise 时等待结果后再决定。
 * 函数本身不是 `async`，三条 ingress 同步返回 false 的常态路径不分配 Promise。
 *
 * 「返回不返回 Promise 是语义的一部分」这条跨模块约束（含命令必须收在一层
 * `:entities:bot_command` 子链后面）见 @see ../../docs/cn/04-invariants.md
 * 的「线程与状态归属」。
 */
function claimOrContinue(
  claimed: boolean | Promise<boolean>,
  next: NextFunction
): Promise<void> | undefined {
  if (typeof claimed !== "boolean") {
    return claimed.then(
      (handled: boolean): Promise<void> | undefined => handled ? undefined : next()
    );
  }
  return claimed ? undefined : next();
}

/**
 * 显式安装完整的 grammY 更新链。模块导入本身不修改 Bot；调用一次本函数才
 * 注册 middleware、命令和各类 update handler。
 *
 * 从 update_id 记账到消息兜底的前置链按顺序收进一个数组，通过 `bot.use(...preamble)`
 * 一次登记，由 grammY 执行链调度和 next 约束；其余按 update 类型分发的 handler
 * 通过 `bot.on` 登记。
 */
export function registerHandlers(bot: Bot): HandlerRegistration {
  let lastSeenUpdateId: number = 0;
  const preamble: MiddlewareFn<Context>[] = [];

  // 追踪已进入处理的最大 update_id，停机时用于确认 Telegram offset。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> => {
    if (ctx.update.update_id > lastSeenUpdateId) lastSeenUpdateId = ctx.update.update_id;
    return next();
  });

  // 收到其他机器人的 message 时在接收链前段计数；超额更新不进入回执、初始化、
  // 身份预热或业务分发。频道身份与本机器人自己的发言不计数。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> | undefined =>
    shouldPassBotMessage(ctx.message, ctx.me.id) ? next() : undefined);

  // 运势签名回执是 chosen_inline_result 之外的确认路径，转发副本同样有效，
  // 在 `shouldPassInitGate` 网关前检查。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> => {
    // `ctx.msg` 是每次求值的 getter 链（grammy/out/context.js 的 `get msg()`），
    // 多次读取处先取成局部变量。
    const message: Message | undefined = ctx.msg;
    const confirmation: Promise<void> | undefined = confirmLuckDraw(
      message?.text,
      message?.entities
    );
    return confirmation === undefined ? next() : confirmation.then(next);
  });

  // 未初始化群和不允许的私聊命令在这里终止，不进入授权维护、身份预热、
  // 验证、命令与 AI 链路。群内只有首次 /init 与 my_chat_member 等网关自身
  // 明确放行的更新能越过初始化状态；私聊只接受超级管理员的 /send。
  // 网关拒绝时仍摘除已保存的退群成员，不新增候选。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> | undefined => {
    if (!shouldPassInitGate(ctx)) {
      observeWedMemberDeparture(ctx, ctx.chat);
      return undefined;
    }
    return shouldPassPrivateCommandGate(ctx) ? next() : undefined;
  });

  // 黑白名单判断保持同步 LRU 读取；每个 update 在进入 Anti-Raid 和命令前，一次性
  // 补齐可见身份的冷缺失。热命中不跨线程，冷读一并查询各身份关系并写入正/负缓存。
  // 预热是 best-effort：Disk I/O 自愈窗口里冷读失败时 prefetchIdentityPolicies
  // 就地降级并返回 false（见该函数头注），本中间件不消费这个结论，留冷身份按
  // fail-closed 判定。
  //
  // 不写成 async：全热 update 的 ids 为 null，直接 next()；只有冷读分支返回 Promise。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> => {
    // 成员集合只消费通过初始化网关的主线程更新，实际增删由 wed owner 合并落盘。
    observeWedMembers(ctx);
    // 同上：`ctx.msg` 与它的 `reply_to_message` 在本段里多次读取，先各取一次。
    const message: Message | undefined = ctx.msg;
    const repliedTo: Message | undefined = message?.reply_to_message;
    let ids: number[] | null = null;
    if (ctx.from !== undefined) ids = appendColdIdentityId(ids, ctx.from.id);
    if (message?.sender_chat !== undefined) {
      ids = appendColdIdentityId(ids, message.sender_chat.id);
    } else {
      // 纯频道帖没有 from 也没有 sender_chat：频道自己就是 ctx.chat，
      // users/visibleSender.ts、commands/commandActor.ts 与 infra/updateGate.ts
      // 按这个 id 解析行为主体。`ctx.chat` 只在这条分支读取。
      const chat: Chat | undefined = ctx.chat;
      if (chat?.type === "channel") ids = appendColdIdentityId(ids, chat.id);
    }
    if (repliedTo?.from !== undefined) {
      ids = appendColdIdentityId(ids, repliedTo.from.id);
    }
    if (repliedTo?.sender_chat !== undefined) {
      ids = appendColdIdentityId(ids, repliedTo.sender_chat.id);
    }
    const forwardOriginId: number | undefined =
      messageOriginIdentityId(message?.forward_origin);
    if (forwardOriginId !== undefined) {
      ids = appendColdIdentityId(ids, forwardOriginId);
    }
    const repliedForwardOriginId: number | undefined =
      messageOriginIdentityId(repliedTo?.forward_origin);
    if (repliedForwardOriginId !== undefined) {
      ids = appendColdIdentityId(ids, repliedForwardOriginId);
    }
    const externalReplyOriginId: number | undefined =
      messageOriginIdentityId(message?.external_reply?.origin);
    if (externalReplyOriginId !== undefined) {
      ids = appendColdIdentityId(ids, externalReplyOriginId);
    }
    if (message?.new_chat_members !== undefined) {
      for (const member of message.new_chat_members) {
        ids = appendColdIdentityId(ids, member.id);
      }
    }
    if (message?.left_chat_member !== undefined) {
      ids = appendColdIdentityId(ids, message.left_chat_member.id);
    }
    if (ctx.chatMember !== undefined) {
      ids = appendColdIdentityId(ids, ctx.chatMember.new_chat_member.user.id);
    }
    return ids === null ? next() : prefetchIdentityPolicies(ids).then(next);
  });

  // 私聊命令已在前置网关统一收口；活动中的 /send 中转会话只把非命令消息
  // 直接短路到消息流水线。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> | undefined => {
    if (shouldRoutePrivateProxyMessage(ctx)) return handleIncomingMessageMiddleware(ctx);
    return next();
  });

  // message / channel_post 上的 ingress 与消息兜底收进前置链，在 middleware
  // 内自行判定 update 类型。判据与 on("message")、on(["message", "channel_post"])
  // 相同（allowed_updates 不含 edited_*，消息类 update 只有 message 与 channel_post），
  // 命中集合、顺序与认领语义一致。

  // 入群验证位于命令处理器之前。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> | undefined => {
    const message: Message | undefined = ctx.message;
    return message === undefined
      ? next()
      : claimOrContinue(handleAntiRaidMessageIngress(message, ctx.me.id), next);
  });

  // gag 覆盖命令消息，位于全部 bot.command 之前；Anti-Raid 先看原始消息，
  // 广告/刷屏/待验证追踪按原始消息计数。被 gag 的消息即使 Telegram 删除失败
  // 也在这里终止，不进入 AI、copy 或命令处理器。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> | undefined => {
    const message: Message | undefined = ctx.message;
    return message === undefined
      ? next()
      : claimOrContinue(handleGagMessageIngress(message, ctx.me.id), next);
  });

  // /qa set 表单投递覆盖命令消息与 channel_post（频道里的「问题:」「回答:」
  // 是频道帖）；被认领的消息已删除，终止本条 update。
  preamble.push((ctx: Context, next: NextFunction): Promise<void> | undefined => {
    const message: Message | undefined = ctx.message ?? ctx.channelPost;
    return message === undefined ? next() : claimOrContinue(handleQaMessageIngress(message), next);
  });

  // 授权维护命令与其余命令一样排在上面那道 ingress 之后：/permission 与 /white
  // 的 handler 不调 next()，需经过 handleAntiRaidMessageIngress 后才执行。
  // 全部命令收在一层 `:entities:bot_command` 子链后面：外闸判据与
  // Context.has.command() 的第一步相同，是每条命令判据的超集，
  // 不带 bot_command 实体的消息一次跳过整组。
  // 中文动作命令没有 bot_command 实体，由下面的「/」外闸承接。
  const commands: Composer<Filter<Context, ":entities:bot_command">> = new Composer();
  commands.command("permission", handlePermissionCommand);
  commands.command("white", handleWhiteCommand);
  commands.command("copy", handleCopyCommand);
  commands.command("translate", handleTranslateCommand);
  commands.command("icon", handleIconCommand);
  commands.command("wed", dispatchWedCommand);
  commands.command("h_image", handleHImageCommand);
  commands.command("info", handleInfoCommand);
  commands.command("block", handleBlockCommand);
  commands.command("batch_kick", handleBatchKickCommand);
  commands.command("ai_chat", handleAiChatCommand);
  commands.command("clear_context", handleClearContextCommand);
  commands.command("ad_detect", handleAdDetectCommand);
  commands.command("flood_control", handleFloodControlCommand);
  commands.command("antiraid", handleAntiRaidCommand);
  commands.command("bot_status", handleBotStatusCommand);
  commands.command("mood", handleMoodCommand);
  commands.command("init", handleInitCommand);
  commands.command("quiet", handleQuietCommand);
  commands.command("unquiet", handleUnquietCommand);
  commands.command("mute", handleMuteCommand);
  commands.command("unmute", handleUnmuteCommand);
  commands.command("gag", handleGagCommand);
  commands.command("ungag", handleUngagCommand);
  commands.command("send", handleSendCommand);
  commands.command("qa", handleQaCommand);
  // 菜单占位项：在命令菜单里展示「/<中文动作名>」用法（那类命令名注册不进菜单，
  // 见 consts/commands.ts）；handleCjkActionUsageCommand 回复用法并终止链路，
  // 不落到消息兜底。
  commands.command("x", handleCjkActionUsageCommand);
  // 外闸直接用 grammY 的 matchFilter，与 `bot.on(":entities:bot_command")` 同一个判据。
  const isBotCommand: (ctx: Context) => ctx is Filter<Context, ":entities:bot_command"> =
    matchFilter(":entities:bot_command");
  const commandMiddleware: MiddlewareFn<Filter<Context, ":entities:bot_command">> = commands.middleware();
  preamble.push((ctx: Context, next: NextFunction): unknown =>
    isBotCommand(ctx) ? commandMiddleware(ctx, next) : next());

  // `/咬`、`/贴贴` 这类中文动作命令没有 Telegram 的 bot_command 实体，bot.command
  // 匹配不到，按消息原文 hears。排在消息兜底处理器之前；不认领的形态由 handler
  // 自己 next() 放行。CJK_ACTION_COMMAND_PATTERN 以 `^\/` 开头，「原文首字符是 /」
  // 是它的超集，其余消息不进 hears 子链。原文取法与 Context.has.text() 相同。
  const cjkActions: Composer<Context> = new Composer();
  cjkActions.hears(CJK_ACTION_COMMAND_PATTERN, handleCjkActionCommand);
  const cjkActionMiddleware: MiddlewareFn<Context> = cjkActions.middleware();
  preamble.push((ctx: Context, next: NextFunction): unknown => {
    const message: Message | undefined = ctx.message ?? ctx.channelPost;
    const text: string | undefined = message?.text ?? message?.caption;
    return text?.charCodeAt(0) === SLASH_CHAR_CODE
      ? cjkActionMiddleware(ctx, next)
      : next();
  });
  preamble.push((ctx: Context, next: NextFunction): Promise<void> | undefined =>
    (ctx.message ?? ctx.channelPost) === undefined ? next() : handleIncomingMessageMiddleware(ctx));
  bot.use(...preamble);
  bot.on("message_reaction", handleReaction);
  bot.on("chat_member", handleChatMemberUpdate);
  bot.on("my_chat_member", handleMyChatMemberUpdate);
  // /wed 结果和 /qa query 翻页按钮排在入群验证之前：前缀各自独立，认领了就
  // 不再往下走，没认领的原样交给验证按钮。
  bot.on("callback_query:data", async (
    ctx: Filter<Context, "callback_query:data">,
    next: NextFunction
  ): Promise<void> => {
    if (await dispatchWedCallback(ctx)) return;
    if (await handleQaBoardCallback(ctx)) return;
    return next();
  });
  bot.on("callback_query:data", handleVerificationCallback);
  bot.on("inline_query", handleInlineQuery);
  bot.on("chosen_inline_result", handleLuckChosenInlineResult);

  bot.catch((err: BotError<Context>): never => {
    // GrammyError 携带完整请求 payload，这里只记录状态码和描述。
    if (err.error instanceof GrammyError) {
      logger.error(
        `Unhandled error while handling update ${err.ctx.update.update_id}: ` +
        `${err.error.error_code} ${err.error.description}`
      );
    } else {
      logger.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
    }
    // 记录后继续向 acknowledged runner 传播，不吞掉异常；失败的 update
    // （包括 durability barrier 失败）因此不会被 getUpdates 确认。
    throw err.error;
  });

  return { getLastSeenUpdateId: (): number => lastSeenUpdateId };
}
