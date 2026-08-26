import { GrammyError, type Bot } from "grammy";
import { handleIncomingMessage, handleReaction } from "../auto";
import {
  confirmLuckDraw,
  handleAdDetectCommand,
  handleAiChatCommand,
  handleBatchKickCommand,
  handleBlockCommand,
  handleBotStatusCommand,
  handleCjkActionCommand,
  handleCjkActionUsageCommand,
  handleCopyCommand,
  handleAntiRaidCommand,
  handleFloodControlCommand,
  handleGagCommand,
  handleGagMessageIngress,
  handleQaBoardCallback,
  handleQaMessageIngress,
  handleQueryQaCommand,
  handleRemoveQaCommand,
  handleSetQaCommand,
  handleInitCommand,
  handleJaCopyCommand,
  handleInlineQuery,
  handleLuckChosenInlineResult,
  handleMuteCommand,
  handlePermissionCommand,
  handleQueryMoodCommand,
  handleQuietCommand,
  handleSendCommand,
  handleResetIconCommand,
  handleStealIconCommand,
  handleStopCommand,
  handleSwitchMoodCommand,
  handleUnblockCommand,
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
import { CJK_ACTION_COMMAND_PATTERN } from "../consts/commands";
import { logger } from "../infra/logger";
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
import type {
  BotError,
  CommandContext,
  Context,
  Filter,
  HearsContext,
  NextFunction,
} from "grammy";
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
 * 显式安装完整的 grammY 更新链。模块导入本身不修改 Bot；调用一次本函数才
 * 注册 middleware、命令和各类 update handler。
 */
export function registerHandlers(bot: Bot): HandlerRegistration {
  let lastSeenUpdateId: number = 0;

  // 追踪已进入处理的最大 update_id，停机时用于确认 Telegram offset。
  bot.use((ctx: Context, next: NextFunction): Promise<void> => {
    if (ctx.update.update_id > lastSeenUpdateId) lastSeenUpdateId = ctx.update.update_id;
    return next();
  });

  // 运势签名回执是 chosen_inline_result 之外的确认路径。转发副本也有效，
  // 因此必须在 isInit 网关前检查。
  bot.use((ctx: Context, next: NextFunction): Promise<void> => {
    const confirmation: Promise<void> | undefined = confirmLuckDraw(
      ctx.msg?.text,
      ctx.msg?.entities
    );
    return confirmation === undefined ? next() : confirmation.then(next);
  });

  // 未初始化群和不允许的私聊命令在这里终止，避免继续进入授权维护、身份预热、
  // 验证、命令与 AI 链路。群内只有首次 /init 与 my_chat_member 等网关自身
  // 明确放行的更新能越过初始化状态；私聊只接受超级管理员的 /send。
  bot.use((ctx: Context, next: NextFunction): Promise<void> | undefined =>
    shouldPassInitGate(ctx) && shouldPassPrivateCommandGate(ctx) ? next() : undefined
  );

  // 黑白名单判断保持同步 LRU 读取；每个 update 在进入 Anti-Raid 和命令前，一次性
  // 补齐可见身份的冷缺失。热命中不跨线程，冷读同时查询两表并写入正/负缓存。
  // 预热是 best-effort：Disk I/O 自愈窗口里冷读会失败，prefetchIdentityPolicies
  // 自己就地降级并返回 false（异常逸出会被 bot.catch 重抛成整进程重启循环，
  // 见该函数头注）。本中间件不消费这个结论——留冷即按 fail-closed 判定。
  //
  // **不写成 async**：全热 update 的 ids 恒为 null，不应为每条 update 无条件创建
  // promise 与 async 帧；只有冷读分支返回实际 Promise。
  bot.use((ctx: Context, next: NextFunction): Promise<void> => {
    let ids: number[] | null = null;
    if (ctx.from !== undefined) ids = appendColdIdentityId(ids, ctx.from.id);
    if (ctx.msg?.sender_chat !== undefined) {
      ids = appendColdIdentityId(ids, ctx.msg.sender_chat.id);
    } else if (ctx.chat?.type === "channel") {
      // 纯粹的频道帖没有 from、也没有 sender_chat：频道自己就是 ctx.chat，
      // 而 users/visibleSender.ts、commands/commandActor.ts 与 infra/updateGate.ts
      // 都按这个 id 解析行为主体。漏掉它的话，已在 whitelist_entries 里的频道
      // 在自己频道发 /query_mood、/bot_status 会撞上冷 LRU 的 fail-closed 判定，
      // 被当成未授权拒绝，直到别的 update 偶然把这个 id 预热进来。
      ids = appendColdIdentityId(ids, ctx.chat.id);
    }
    if (ctx.msg?.reply_to_message?.from !== undefined) {
      ids = appendColdIdentityId(ids, ctx.msg.reply_to_message.from.id);
    }
    if (ctx.msg?.reply_to_message?.sender_chat !== undefined) {
      ids = appendColdIdentityId(ids, ctx.msg.reply_to_message.sender_chat.id);
    }
    const forwardOriginId: number | undefined =
      messageOriginIdentityId(ctx.msg?.forward_origin);
    if (forwardOriginId !== undefined) {
      ids = appendColdIdentityId(ids, forwardOriginId);
    }
    const repliedForwardOriginId: number | undefined =
      messageOriginIdentityId(ctx.msg?.reply_to_message?.forward_origin);
    if (repliedForwardOriginId !== undefined) {
      ids = appendColdIdentityId(ids, repliedForwardOriginId);
    }
    const externalReplyOriginId: number | undefined =
      messageOriginIdentityId(ctx.msg?.external_reply?.origin);
    if (externalReplyOriginId !== undefined) {
      ids = appendColdIdentityId(ids, externalReplyOriginId);
    }
    if (ctx.msg?.new_chat_members !== undefined) {
      for (const member of ctx.msg.new_chat_members) {
        ids = appendColdIdentityId(ids, member.id);
      }
    }
    if (ctx.msg?.left_chat_member !== undefined) {
      ids = appendColdIdentityId(ids, ctx.msg.left_chat_member.id);
    }
    if (ctx.chatMember !== undefined) {
      ids = appendColdIdentityId(ids, ctx.chatMember.new_chat_member.user.id);
    }
    return ids === null ? next() : prefetchIdentityPolicies(ids).then(next);
  });

  // 私聊命令已在前置网关统一收口；活动中的 /send 中转会话只把非命令消息
  // 直接短路到消息流水线。
  bot.use((ctx: Context, next: NextFunction): Promise<void> | undefined => {
    if (shouldRoutePrivateProxyMessage(ctx)) return handleIncomingMessage(ctx);
    return next();
  });

  // 入群验证必须早于命令处理器，否则待验证用户发出的命令不会被追踪清理。
  bot.on("message", async (ctx: Filter<Context, "message">, next: NextFunction): Promise<void> => {
    if (await handleAntiRaidMessageIngress(ctx.message, ctx.me.id)) return;
    return next();
  });

  // gag 同样要覆盖命令消息，因此必须位于全部 bot.command 之前；Anti-Raid 先看
  // 原始消息，才能保持广告/刷屏/待验证追踪的既有事实口径。被 gag 的消息即使
  // Telegram 删除失败也在这里终止，不得继续喂给 AI、copy 或命令处理器。
  bot.on("message", async (ctx: Filter<Context, "message">, next: NextFunction): Promise<void> => {
    if (await handleGagMessageIngress(ctx.message, ctx.me.id)) return;
    return next();
  });

  // /set_qa 表单投递同样要覆盖命令消息，且必须终止本条 update：那条投递消息
  // 已经被认领并删除，再放进 AI、复读或命令链路只会处理一个不存在的东西。
  // 必须同时挂在 channel_post 上——频道里的「问题:」「回答:」是频道帖，只监听
  // message 的话频道根本填不了表单，而频道能设置问答正是本轮改动的目的。
  bot.on(["message", "channel_post"], async (
    ctx: Filter<Context, "message" | "channel_post">,
    next: NextFunction
  ): Promise<void> => {
    if (await handleQaMessageIngress(ctx.msg)) return;
    return next();
  });

  // 授权维护命令与其余命令一样排在上面那道 ingress 之后，没有例外：这两条
  // handler 都不调 next()，注册在 ingress 之前的话，/permission 与 /white 会
  // 整条绕开 handleAntiRaidMessageIngress —— 发的人不计入刷屏窗口却每条都能
  // 拿到一条机器人回复（非白名单是拒绝文案，白名单是整份权限 JSON），等于一个
  // 不受防刷屏约束的回复放大器；黑名单频道身份发的这两条命令也不会被就地删除，
  // 待验证成员发的更不会产生 trackedMessage。
  bot.command("permission", (ctx: CommandContext<Context>): Promise<void> => handlePermissionCommand(ctx));
  bot.command("white", (ctx: CommandContext<Context>): Promise<void> => handleWhiteCommand(ctx));
  bot.command("copy", (ctx: CommandContext<Context>): Promise<void> => handleCopyCommand(ctx));
  bot.command("r_copy", (ctx: CommandContext<Context>): Promise<void> => handleCopyCommand(ctx, "reverse"));
  bot.command("nya_copy", (ctx: CommandContext<Context>): Promise<void> => handleCopyCommand(ctx, "nya"));
  bot.command("ja_copy", (ctx: CommandContext<Context>): Promise<void> => handleJaCopyCommand(ctx));
  bot.command("steal_icon", (ctx: CommandContext<Context>): Promise<void> => handleStealIconCommand(ctx));
  bot.command("reset_icon", (ctx: CommandContext<Context>): Promise<void> => handleResetIconCommand(ctx));
  bot.command("stop_copy", (ctx: CommandContext<Context>): Promise<void> => handleStopCommand(ctx));
  bot.command("block", (ctx: CommandContext<Context>): Promise<void> => handleBlockCommand(ctx));
  bot.command("batch_kick", (ctx: CommandContext<Context>): Promise<void> => handleBatchKickCommand(ctx));
  bot.command("unblock", (ctx: CommandContext<Context>): Promise<void> => handleUnblockCommand(ctx));
  bot.command("ai_chat", (ctx: CommandContext<Context>): Promise<void> => handleAiChatCommand(ctx));
  bot.command("ad_detect", (ctx: CommandContext<Context>): Promise<void> => handleAdDetectCommand(ctx));
  bot.command("flood_control", (ctx: CommandContext<Context>): Promise<void> => handleFloodControlCommand(ctx));
  bot.command("antiraid", (ctx: CommandContext<Context>): Promise<void> => handleAntiRaidCommand(ctx));
  bot.command("bot_status", (ctx: CommandContext<Context>): Promise<void> => handleBotStatusCommand(ctx));
  bot.command("query_mood", (ctx: CommandContext<Context>): Promise<void> => handleQueryMoodCommand(ctx));
  bot.command("switch_mood", (ctx: CommandContext<Context>): Promise<void> => handleSwitchMoodCommand(ctx));
  bot.command("init", (ctx: CommandContext<Context>): Promise<void> => handleInitCommand(ctx));
  bot.command("quiet", (ctx: CommandContext<Context>): Promise<void> => handleQuietCommand(ctx));
  bot.command("unquiet", (ctx: CommandContext<Context>): Promise<void> => handleUnquietCommand(ctx));
  bot.command("mute", (ctx: CommandContext<Context>): Promise<void> => handleMuteCommand(ctx));
  bot.command("unmute", (ctx: CommandContext<Context>): Promise<void> => handleUnmuteCommand(ctx));
  bot.command("gag", (ctx: CommandContext<Context>): Promise<void> => handleGagCommand(ctx));
  bot.command("ungag", (ctx: CommandContext<Context>): Promise<void> => handleUngagCommand(ctx));
  bot.command("send", (ctx: CommandContext<Context>): Promise<void> => handleSendCommand(ctx));
  bot.command("set_qa", (ctx: CommandContext<Context>): Promise<void> => handleSetQaCommand(ctx));
  bot.command("query_qa", (ctx: CommandContext<Context>): Promise<void> => handleQueryQaCommand(ctx));
  bot.command("remove_qa", (ctx: CommandContext<Context>): Promise<void> => handleRemoveQaCommand(ctx));
  // 菜单占位项：它只为在命令菜单里曝光「/<1~2 个中文字>」这个用法（那类命令名
  // 注册不进菜单，见 consts/commands.ts）。必须在这里终止链路——点菜单会真的把
  // /x 发出去，不拦住的话它会落到下面的消息兜底，被当成普通消息进入 AI/复读
  // 流水线；但也不能什么都不回，否则点了菜单的人只会得到一片沉默。
  bot.command("x", (ctx: CommandContext<Context>): Promise<void> => handleCjkActionUsageCommand(ctx));
  // `/咬`、`/贴贴` 这类中文动作命令拿不到 Telegram 的 bot_command 实体，bot.command
  // 匹配不到，只能按消息原文 hears。必须排在消息兜底处理器之前，否则会被当成
  // 普通消息进入 AI/复读流水线；不认领的形态由 handler 自己 next() 放行。
  bot.hears(CJK_ACTION_COMMAND_PATTERN, (ctx: HearsContext<Context>, next: NextFunction): Promise<void> => handleCjkActionCommand(ctx, next));
  bot.on(["message", "channel_post"], (ctx: Filter<Context, "message" | "channel_post">): Promise<void> => handleIncomingMessage(ctx));
  bot.on("message_reaction", (ctx: Filter<Context, "message_reaction">): Promise<void> => handleReaction(ctx));
  bot.on("chat_member", (ctx: Filter<Context, "chat_member">): Promise<void> => handleChatMemberUpdate(ctx));
  bot.on("my_chat_member", (ctx: Filter<Context, "my_chat_member">): Promise<void> => handleMyChatMemberUpdate(ctx));
  // /query_qa 看板的翻页按钮排在入群验证之前：两者前缀互不为前缀，认领了就
  // 不再往下走，没认领的原样交给验证按钮。
  bot.on("callback_query:data", async (
    ctx: Filter<Context, "callback_query:data">,
    next: NextFunction
  ): Promise<void> => {
    if (await handleQaBoardCallback(ctx)) return;
    return next();
  });
  bot.on("callback_query:data", (ctx: Filter<Context, "callback_query:data">): Promise<void> =>
    handleVerificationCallback(ctx));
  bot.on("inline_query", (ctx: Filter<Context, "inline_query">): Promise<void> => handleInlineQuery(ctx));
  bot.on("chosen_inline_result", (ctx: Filter<Context, "chosen_inline_result">): Promise<void> => handleLuckChosenInlineResult(ctx));

  bot.catch((err: BotError<Context>): never => {
    // GrammyError 携带完整请求 payload；这里只记录状态码和描述，避免日志泄漏
    // 可能嵌在 URL 或 inline result 中的 BOT_TOKEN。
    if (err.error instanceof GrammyError) {
      logger.error(
        `Unhandled error while handling update ${err.ctx.update.update_id}: ` +
        `${err.error.error_code} ${err.error.description}`
      );
    } else {
      logger.error(`Unhandled error while handling update ${err.ctx.update.update_id}:`, err.error);
    }
    // 记录后必须继续向 acknowledged runner 传播。吞掉异常会让 bot.handleUpdate
    // resolve，下一次 getUpdates 随即确认本次失败（包括 durability barrier
    // 失败）的 update，进程重启后 Telegram 也不会重投。
    throw err.error;
  });

  return { getLastSeenUpdateId: (): number => lastSeenUpdateId };
}
